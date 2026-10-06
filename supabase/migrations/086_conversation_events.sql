-- ============================================================
-- 086_conversation_events
--
-- Histórico de atendimento por conversa — append-only.
--
-- CONTEXTO
--   conversations.status / assigned_agent_id / queue_id são estado
--   ATUAL e mutável: atribuições, transferências, encerramentos e
--   reaberturas sobrescrevem o valor anterior sem deixar rastro
--   (tickets/ticket_events só cobrem conversas com ticket — 0 em
--   produção na data desta migration). Esta migration passa a
--   registrar cada mudança operacional relevante numa tabela própria,
--   capturada por trigger em conversations, de modo que TODO caminho
--   de escrita (Inbox, RPCs de ticket, webhook UAZAPI/Meta, Flows,
--   Automations, IA) é coberto sem alterar nenhum código.
--
-- O QUE ESTA MIGRATION FAZ
--   1. public.conversation_events (append-only):
--        - IDs de ator/agentes/filas SEM FK + nome congelado no
--          momento do evento (*_name). Sem FK porque um ON DELETE SET
--          NULL seria um UPDATE (bloqueado pelo append-only) e faria
--          falhar a exclusão de usuários/filas; sem FK, id e nome
--          sobrevivem a qualquer exclusão posterior.
--        - account_id e conversation_id com FK ON DELETE CASCADE: o
--          histórico acompanha a conversa/conta (exclusão de contato
--          → conversations CASCADE → conversation_events CASCADE).
--        - SEM contact_id: o merge de contatos (022) re-aponta
--          conversations.contact_id e depois apaga o contato perdedor
--          — uma FK CASCADE apagaria eventos de uma conversa que
--          sobreviveu. O contato vem do JOIN com conversations.
--        - SEM ticket_id (0 tickets em produção; ticket_events já
--          registra o ciclo do ticket; correlação por conversa+tempo).
--   2. Snapshot inicial: um 'history_started' para CADA conversation
--      existente sob o LOCK, com o estado conhecido naquele instante
--      (NÃO é "abertura do atendimento"). Gerado só aqui — a trigger
--      nunca gera history_started. Conversations criadas depois desta
--      migration recebem 'opened'.
--   3. Trigger de captura AFTER INSERT / AFTER UPDATE em conversations.
--   4. Proteção append-only + RLS (regra A).
--   5. Tenancy estrutural: BEFORE INSERT em conversation_events exige
--      account_id = conversations.account_id da conversation_id indicada
--      (padrão de ticket_events_validate_tenancy/040). Vale para QUALQUER
--      INSERT, inclusive do owner. Sem fail-safe próprio: dentro da
--      captura, a rejeição é absorvida pelo EXCEPTION da captura.
--
-- EVENTOS (no máximo UM por INSERT/UPDATE; o evento sempre guarda o
-- par antes/depois COMPLETO de status, responsável e fila)
--   history_started  snapshot da migration (só to_*; ator NULL)
--   opened           INSERT de conversation (só to_*)
--   reopened         status closed/finalized → fora desse conjunto
--   closed           status → 'closed'     (mudou)
--   finalized        status → 'finalized'  (mudou; inclui closed → finalized,
--                    exibido como refinamento do MESMO encerramento)
--   assigned         responsável NULL → X
--   reassigned       responsável X → Y
--   unassigned       responsável X → NULL
--   queue_changed    fila mudou (responsável igual, ou → NULL junto:
--                    transferência de setor)
--
--   Precedência num mesmo UPDATE:
--     1. reopened  2. closed/finalized  3. assigned/reassigned/unassigned
--     (exceto fila mudou E responsável → NULL: é queue_changed)
--     4. queue_changed  5. nada.
--   Ex.: retorno do cliente (closed→pending, Arthur→NULL, Comercial→NULL)
--   gera UM 'reopened' — sem 'unassigned'/'queue_changed' redundantes.
--   pending ↔ in_progress ↔ waiting_customer sozinho NÃO gera evento;
--   mensagens comuns (last_message_*, unread_count) NÃO chamam a função
--   (WHEN da trigger compara os valores OLD/NEW finais).
--
-- ATOR
--   actor_user_id = auth.uid(): o `sub` das claims do JWT da requisição
--   (request.jwt.claims). SECURITY DEFINER troca current_user, não as
--   configurações da transação — o usuário continua identificado dentro
--   de RPCs (mesmo mecanismo que claim_ticket/068 e
--   notify_conversation_assigned/027 já usam). service_role (webhook,
--   Flows, Automations, IA, API v1), SQL Editor e migrations → NULL =
--   sistema. Nenhum ator é inventado.
--
-- FAIL-SAFE
--   Toda a lógica da captura roda dentro de BEGIN … EXCEPTION WHEN
--   OTHERS (subtransação): uma falha ao gravar o histórico desfaz só o
--   INSERT do evento e emite WARNING com código fixo + TG_OP + SQLSTATE
--   (sem dado pessoal). A operação em conversations segue normalmente.
--   As FKs desta tabela são NOT DEFERRABLE (verificadas no fim do
--   próprio INSERT, ainda dentro do bloco protegido). A trigger BEFORE
--   INSERT de tenancy também roda dentro do INSERT — uma divergência de
--   conta vira o mesmo WARNING, sem abortar conversations.
--
-- APPEND-ONLY
--   - anon/authenticated/service_role: sem INSERT/UPDATE/DELETE/TRUNCATE
--     (privilégio negado antes de qualquer trigger); só SELECT para
--     authenticated e service_role. Nenhuma policy de escrita.
--   - BEFORE UPDATE (linha) e BEFORE TRUNCATE (statement) sempre
--     rejeitam — inclusive para o owner.
--   - DELETE: SEM trigger. Protegido por privilégio; o ON DELETE
--     CASCADE roda como owner da tabela filha e continua funcionando;
--     retenção administrativa é DELETE pelo owner (postgres).
--   - Limite: owner/superuser pode desabilitar triggers ou alterar a
--     tabela — a proteção cobre aplicação e usuários, não é
--     imutabilidade absoluta.
--
-- RLS (regra A)
--   Quem enxerga a conversation enxerga todo o histórico dela. A policy
--   deriva a visibilidade por EXISTS em conversations — a subconsulta
--   passa pela RLS de conversations (regra híbrida da 083), sem replicar
--   a lógica. Sem recursão (as policies de conversations não referenciam
--   conversation_events).
--
-- LOCK
--   SHARE ROW EXCLUSIVE em conversations durante a migration: bloqueia
--   escritas concorrentes (por alguns instantes) para que o snapshot e a
--   criação das triggers sejam consistentes — nenhuma conversation fica
--   sem history_started nem recebe os dois. SET LOCAL lock_timeout = '5s'
--   antes do LOCK: se conversations estiver presa por outra transação, a
--   migration falha em 5s com rollback completo (sem retry automático)
--   em vez de esperar e enfileirar o Inbox/webhook atrás dela.
--   O snapshot usa statement_timestamp(): mesmo instante para todas as
--   linhas, tomado DEPOIS de obtido o lock.
--
-- Rollback (ver supabase/validation/086_conversation_events_check.sql):
--   nível 1 (recomendado): DROP TRIGGER conversation_events_on_insert e
--   conversation_events_on_update ON public.conversations — a captura
--   para e o histórico é preservado. DROP TABLE destrói o histórico.
--
-- NÃO APLICADA — aplicação manual (SQL Editor) após revisão.
-- ============================================================

BEGIN;

-- Falha rápida (e rollback completo) se conversations estiver bloqueada.
SET LOCAL lock_timeout = '5s';

LOCK TABLE public.conversations IN SHARE ROW EXCLUSIVE MODE;

-- ------------------------------------------------------------
-- 1) Tabela
-- ------------------------------------------------------------
CREATE TABLE public.conversation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id)      ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  actor_user_id   UUID NULL,
  actor_name      TEXT NULL,
  from_agent_id   UUID NULL,
  from_agent_name TEXT NULL,
  to_agent_id     UUID NULL,
  to_agent_name   TEXT NULL,
  from_queue_id   UUID NULL,
  from_queue_name TEXT NULL,
  to_queue_id     UUID NULL,
  to_queue_name   TEXT NULL,
  from_status     TEXT NULL,
  to_status       TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conversation_events_type_check CHECK (event_type IN (
    'history_started', 'opened', 'reopened', 'assigned', 'reassigned',
    'unassigned', 'queue_changed', 'closed', 'finalized'
  )),

  CONSTRAINT conversation_events_actor_name_check
    CHECK (actor_user_id IS NOT NULL OR actor_name IS NULL),

  -- Cada tipo restringe só a própria dimensão; as demais são livres
  -- (o evento guarda todos os pares antes/depois de mudanças
  -- simultâneas). COALESCE(…, false): um NULL na expressão REJEITA.
  CONSTRAINT conversation_events_shape_check CHECK (COALESCE(
    CASE event_type
      WHEN 'history_started' THEN
        actor_user_id IS NULL
        AND from_status IS NULL
        AND from_agent_id IS NULL AND from_agent_name IS NULL
        AND from_queue_id IS NULL AND from_queue_name IS NULL
        AND to_status IS NOT NULL
      WHEN 'opened' THEN
        from_status IS NULL
        AND from_agent_id IS NULL AND from_agent_name IS NULL
        AND from_queue_id IS NULL AND from_queue_name IS NULL
        AND to_status IS NOT NULL
      WHEN 'reopened' THEN
        from_status IN ('closed', 'finalized')
        AND to_status NOT IN ('closed', 'finalized')
      WHEN 'closed' THEN
        from_status IS NOT NULL AND from_status <> 'closed'
        AND to_status = 'closed'
      WHEN 'finalized' THEN
        from_status IS NOT NULL AND from_status <> 'finalized'
        AND to_status = 'finalized'
      ELSE
        -- assigned / reassigned / unassigned / queue_changed:
        -- nunca cruzam a fronteira de encerramento (pela precedência,
        -- isso seria reopened / closed / finalized).
        from_status IS NOT NULL AND to_status IS NOT NULL
        AND NOT (from_status IN ('closed', 'finalized') AND to_status NOT IN ('closed', 'finalized'))
        AND NOT (to_status IN ('closed', 'finalized') AND from_status <> to_status)
        AND CASE event_type
          WHEN 'assigned' THEN
            from_agent_id IS NULL AND to_agent_id IS NOT NULL
          WHEN 'reassigned' THEN
            from_agent_id IS NOT NULL AND to_agent_id IS NOT NULL
            AND from_agent_id <> to_agent_id
          WHEN 'unassigned' THEN
            from_agent_id IS NOT NULL AND to_agent_id IS NULL
          WHEN 'queue_changed' THEN
            from_queue_id IS DISTINCT FROM to_queue_id
            AND (from_agent_id IS NOT DISTINCT FROM to_agent_id OR to_agent_id IS NULL)
        END
    END,
    false
  ))
);

-- Owner explícito: conversation_events_capture (SECURITY DEFINER, owner
-- postgres) depende de postgres poder inserir aqui após o REVOKE ALL.
ALTER TABLE public.conversation_events OWNER TO postgres;

COMMENT ON TABLE public.conversation_events IS
  'Append-only operational history of conversations (086). Written only by trigger conversation_events_capture (and the 086 snapshot). *_name columns are snapshots frozen at event time.';

-- ------------------------------------------------------------
-- 2) Índices (somente os necessários neste primeiro lote)
-- ------------------------------------------------------------
CREATE INDEX idx_conversation_events_conversation
  ON public.conversation_events (conversation_id, created_at);

CREATE INDEX idx_conversation_events_account_created
  ON public.conversation_events (account_id, created_at);

CREATE UNIQUE INDEX idx_conversation_events_one_history_started
  ON public.conversation_events (conversation_id)
  WHERE event_type = 'history_started';

-- ------------------------------------------------------------
-- 2b) Tenancy estrutural — account_id do evento = account_id da
--     conversation. Mesmo padrão de ticket_events_validate_tenancy (040),
--     porém rejeitando também conversation inexistente. Não altera NEW.
--     Sem fail-safe próprio (integridade da tabela): chamada pela
--     captura, a rejeição é absorvida pelo EXCEPTION da captura; num
--     INSERT manual (owner), o INSERT falha. Mensagens fixas, sem IDs.
--     Criada ANTES do snapshot: as linhas do snapshot também passam por ela.
-- ------------------------------------------------------------
CREATE FUNCTION public.conversation_events_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation_account UUID;
BEGIN
  SELECT c.account_id INTO v_conversation_account
  FROM public.conversations c
  WHERE c.id = NEW.conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_events.conversation_id must reference an existing conversation'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.account_id IS DISTINCT FROM v_conversation_account THEN
    RAISE EXCEPTION 'conversation_events.account_id must match the conversation account'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.conversation_events_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_events_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER conversation_events_validate_tenancy
  BEFORE INSERT ON public.conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION public.conversation_events_validate_tenancy();

-- ------------------------------------------------------------
-- 3) Snapshot inicial — SOMENTE as conversations existentes sob o
--    LOCK, todas no mesmo instante: statement_timestamp() é único por
--    statement e tomado depois de obtido o lock.
--    "Estado conhecido no início do histórico", nunca "abertura".
-- ------------------------------------------------------------
INSERT INTO public.conversation_events (
  account_id, conversation_id, event_type,
  to_agent_id, to_agent_name, to_queue_id, to_queue_name, to_status,
  created_at
)
SELECT
  c.account_id, c.id, 'history_started',
  c.assigned_agent_id, p.full_name, c.queue_id, q.name, c.status,
  statement_timestamp()
FROM public.conversations c
LEFT JOIN public.profiles p ON p.user_id = c.assigned_agent_id
LEFT JOIN public.queues   q ON q.id = c.queue_id;

DO $$
BEGIN
  RAISE NOTICE '086 history_started snapshot rows: % (guarde este número para a validação)',
    (SELECT count(*) FROM public.conversation_events WHERE event_type = 'history_started');
END $$;

-- ------------------------------------------------------------
-- 4) Captura — fail-safe: TODA a lógica dentro do bloco protegido.
--    DECLARE sem inicializadores (nada pode falhar antes do bloco).
-- ------------------------------------------------------------
CREATE FUNCTION public.conversation_events_capture()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type       TEXT;
  v_actor      UUID;
  v_old_status TEXT;
  v_old_agent  UUID;
  v_old_queue  UUID;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      v_type := 'opened';
    ELSE
      v_old_status := OLD.status;
      v_old_agent  := OLD.assigned_agent_id;
      v_old_queue  := OLD.queue_id;

      IF OLD.status IN ('closed', 'finalized')
         AND NEW.status NOT IN ('closed', 'finalized') THEN
        v_type := 'reopened';
      ELSIF NEW.status IN ('closed', 'finalized')
            AND OLD.status IS DISTINCT FROM NEW.status THEN
        v_type := NEW.status;  -- 'closed' | 'finalized'
      ELSIF OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id
            AND NOT (OLD.queue_id IS DISTINCT FROM NEW.queue_id
                     AND NEW.assigned_agent_id IS NULL) THEN
        v_type := CASE
          WHEN OLD.assigned_agent_id IS NULL THEN 'assigned'
          WHEN NEW.assigned_agent_id IS NULL THEN 'unassigned'
          ELSE 'reassigned'
        END;
      ELSIF OLD.queue_id IS DISTINCT FROM NEW.queue_id THEN
        v_type := 'queue_changed';
      ELSE
        RETURN NULL;  -- sem mudança operacional relevante
      END IF;
    END IF;

    -- NULL = sistema (service_role / webhook / Flow / Automation / SQL).
    v_actor := auth.uid();

    INSERT INTO public.conversation_events (
      account_id, conversation_id, event_type,
      actor_user_id, actor_name,
      from_agent_id, from_agent_name,
      to_agent_id,   to_agent_name,
      from_queue_id, from_queue_name,
      to_queue_id,   to_queue_name,
      from_status,   to_status
    ) VALUES (
      NEW.account_id, NEW.id, v_type,
      v_actor,               (SELECT full_name FROM public.profiles WHERE user_id = v_actor),
      v_old_agent,           (SELECT full_name FROM public.profiles WHERE user_id = v_old_agent),
      NEW.assigned_agent_id, (SELECT full_name FROM public.profiles WHERE user_id = NEW.assigned_agent_id),
      v_old_queue,           (SELECT name FROM public.queues WHERE id = v_old_queue),
      NEW.queue_id,          (SELECT name FROM public.queues WHERE id = NEW.queue_id),
      v_old_status,          NEW.status
    );
  EXCEPTION WHEN OTHERS THEN
    -- Código fixo, operação e SQLSTATE apenas — nenhum dado pessoal.
    RAISE WARNING 'conversation_events_capture_failed op=% sqlstate=%', TG_OP, SQLSTATE;
  END;
  RETURN NULL;  -- AFTER trigger: valor de retorno ignorado
END;
$$;

ALTER FUNCTION public.conversation_events_capture() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_events_capture() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER conversation_events_on_insert
  AFTER INSERT ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversation_events_capture();

-- Sem lista de colunas (UPDATE OF): o WHEN compara os valores FINAIS
-- de OLD/NEW — mensagens comuns e pending ↔ in_progress não chamam a
-- função; uma mudança feita por trigger BEFORE futura não escapa.
-- Só IS DISTINCT FROM / IN com constantes: nada aqui pode gerar erro.
CREATE TRIGGER conversation_events_on_update
  AFTER UPDATE ON public.conversations
  FOR EACH ROW
  WHEN (
    OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id
    OR OLD.queue_id IS DISTINCT FROM NEW.queue_id
    OR (
      OLD.status IS DISTINCT FROM NEW.status
      AND (OLD.status IN ('closed', 'finalized') OR NEW.status IN ('closed', 'finalized'))
    )
  )
  EXECUTE FUNCTION public.conversation_events_capture();

-- ------------------------------------------------------------
-- 5) Append-only: UPDATE (linha) e TRUNCATE (statement) rejeitados.
--    DELETE: sem trigger (privilégio; CASCADE roda como owner).
-- ------------------------------------------------------------
CREATE FUNCTION public.conversation_events_reject_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events is append-only'
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;  -- inalcançável
END;
$$;

CREATE FUNCTION public.conversation_events_reject_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;  -- inalcançável; retorno de trigger FOR EACH STATEMENT é ignorado
END;
$$;

ALTER FUNCTION public.conversation_events_reject_update()   OWNER TO postgres;
ALTER FUNCTION public.conversation_events_reject_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_events_reject_update()   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.conversation_events_reject_truncate() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER conversation_events_no_update
  BEFORE UPDATE ON public.conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION public.conversation_events_reject_update();

CREATE TRIGGER conversation_events_no_truncate
  BEFORE TRUNCATE ON public.conversation_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.conversation_events_reject_truncate();

-- ------------------------------------------------------------
-- 6) Privilégios + RLS (regra A)
-- ------------------------------------------------------------
ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.conversation_events TO authenticated, service_role;

CREATE POLICY conversation_events_select ON public.conversation_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = conversation_events.conversation_id
        AND c.account_id = conversation_events.account_id
    )
  );

COMMIT;
