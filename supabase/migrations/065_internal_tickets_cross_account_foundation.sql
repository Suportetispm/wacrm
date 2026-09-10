-- ============================================================
-- 065_internal_tickets_cross_account_foundation
--
-- Fundação (schema + tenancy + RLS) para Chamados Internos poderem
-- ser encaminhados de uma unidade (account) de ORIGEM para uma
-- equipe de outra unidade (account) de DESTINO. Mesma divisão de
-- responsabilidade que 052 (fundação) / 054 (operações) já usa neste
-- módulo: esta migration só adiciona schema/triggers/RLS — nenhuma
-- RPC operacional nova (create/update/comment/forward) é criada
-- aqui, isso fica para a 066.
--
-- REVISÃO (auditoria externa pós-primeira versão) — 8 hardenings
-- aplicados antes de qualquer aplicação em staging:
--   1. internal_tickets_update NÃO ganha mais perna de destino nesta
--      migration (Option A da rodada de revisão): até a 066 trazer
--      forward_internal_ticket/update_internal_ticket estendida
--      (SECURITY DEFINER, que não depende de RLS de authenticated
--      para funcionar), UPDATE via client continua estritamente
--      igual ao comportamento pré-065 (só origem). Fecha a janela em
--      que um UPDATE direto via PostgREST poderia tocar um chamado
--      cross-account antes de existir a lógica de autorização fina
--      da 066.
--   2. Novo trigger internal_tickets_guard_target_account_id: mesmo
--      com (1), um admin/owner de ORIGEM continuaria com UPDATE
--      irrestrito sobre a própria linha (nunca perdeu esse direito),
--      e nada impedia esse UPDATE de setar target_account_id para
--      QUALQUER account existente, sem checar
--      internal_ticket_account_links — a checagem de link só existirá
--      dentro da RPC forward_internal_ticket (066). Este trigger
--      fecha esse buraco especificamente: só um caller que já esteja
--      executando como current_user = 'postgres' (ou seja, dentro de
--      uma função SECURITY DEFINER owned by postgres, como a futura
--      forward_internal_ticket) pode mudar target_account_id depois
--      da criação. Nem authenticated, nem service_role cru, nem
--      admin de origem via client conseguem — ver item 7 para a
--      correção que faz essa checagem funcionar de fato.
--   3. internal_ticket_comments_insert (que já existia, sem mudança
--      de arquitetura, desde 052) é REMOVIDA nesta migration, não
--      ampliada: a aplicação já usa exclusivamente a RPC
--      add_internal_ticket_comment (054) para inserir comentários —
--      nenhum caller legítimo depende de INSERT direto. Manter (ou
--      pior, ampliar para 2 accounts) essa policy permitiria um
--      comentário sem o evento 'comment_added' correspondente, e
--      portanto sem o registro de participante derivado dele —
--      inconsistência de histórico. Comentários passam a ser
--      RPC-only, mesmo padrão que internal_ticket_events já tem
--      desde a fundação.
--   4. internal_ticket_comments_update volta a ser IDÊNTICA à 052
--      (só origem) — a versão anterior desta migration tinha
--      ampliado para aceitar autor do destino, mas não existe hoje
--      NENHUMA rota que exponha edição/soft-delete de comentário
--      (nem origem, nem destino) — não há motivo para abrir
--      superfície cross-account que nenhum caller usa. Revisitar
--      quando essa rota for de fato construída.
--   5. internal_tickets_validate_tenancy / internal_ticket_comments_
--      validate_tenancy / internal_ticket_events_validate_tenancy
--      não usam mais "SELECT account_id FROM profiles WHERE
--      user_id = X" (pressupõe 1 linha de profile por usuário) — toda
--      checagem de membership agora é um EXISTS explícito filtrando
--      por (user_id, account_id) juntos, compatível por construção
--      com um futuro profiles N:N (multi-account por usuário) sem
--      precisar reescrever estas funções de novo.
--   6. Privilégios de tabela EXPLÍCITOS para as 2 tabelas novas
--      (internal_ticket_participants, internal_ticket_account_links)
--      — REVOKE ALL FROM PUBLIC/anon/authenticated seguido de GRANT
--      SELECT pontual onde necessário, mesmo padrão já usado por
--      platform_admins/platform_audit_log (046). Não depende mais só
--      dos privilégios padrão que o Supabase concede a toda tabela
--      nova do schema public por padrão (auditado, ver retorno desta
--      rodada) — RLS continua sendo quem decide QUAIS linhas, GRANT
--      agora documenta explicitamente QUE operação pode ao menos ser
--      tentada.
--   7. CORREÇÃO (3ª rodada de revisão externa, achado do item (2)
--      acima): internal_tickets_guard_target_account_id era SECURITY
--      DEFINER OWNER TO postgres — o que faz o Postgres trocar
--      current_user para o OWNER (postgres) durante a própria
--      execução da função, inclusive dentro do corpo que lê
--      current_user. Resultado real: a checagem `current_user <>
--      'postgres'` era SEMPRE falsa, não importa quem tivesse
--      disparado o UPDATE — o guard nunca bloqueava nada, apesar de
--      existir e a intenção do item (2) nunca ter sido cumprida.
--      Corrigido para SECURITY INVOKER (ver seção 2.2 para a
--      explicação completa do mecanismo e dos 4 cenários de chamada).
--      OWNER continua postgres — owner e SECURITY DEFINER/INVOKER são
--      independentes; só DEFINER troca current_user.
--   8. Backfill histórico ADICIONADO para internal_ticket_participants
--      (seção 1.3c) — sem ele, todo created_by/assigned_user_id/
--      actor_user_id/author_id de ANTES desta migration não teria
--      linha em participants (os triggers 2.5/2.6 só capturam
--      participação nova, criada depois da 065). Isso faria um ticket
--      histórico, ao ser encaminhado pela 066, perder acesso de quem
--      interagiu com ele antes de 065 e hoje não é mais created_by/
--      assigned_user_id/membro do team_id atual — quebrando a garantia
--      dos itens 16/17 do checklist no rodapé. INSERT único,
--      idempotente (ON CONFLICT DO NOTHING), sem UPDATE, sem tocar
--      internal_team_members (membership sozinha não é participação).
--      Ver seção 1.3c para as 4 fontes e o cálculo de first_seen_at.
--   9. CORREÇÃO CRÍTICA (auditoria de segurança, pós-aplicação desta
--      revisão): a PERNA 3/3 de internal_tickets_select/comments_
--      select/events_select (seções 3.3/3.5/3.7) concedia VIEW
--      permanente só por existir uma linha em
--      internal_ticket_participants, sem revalidar se o usuário ainda
--      pertence à conta de origem/destino do chamado. Como
--      internal_ticket_participants não tem account_id (por design,
--      seção 1.3) e profiles.account_id é mutável, um usuário movido
--      para outra conta (create_account_member, 056/062) mantinha
--      acesso de leitura permanente a chamados da conta anterior — e o
--      backfill (1.3c) já populava isso para todo o histórico, tornando
--      o vazamento imediato à aplicação desta migration, independente
--      de qualquer encaminhamento cross-account existir. Corrigido
--      adicionando is_account_member(account_id)/is_account_member(
--      target_account_id) como pré-condição da perna, nas 3 policies —
--      mesmo helper já usado nas pernas 1/3 e 2/3, que já checa
--      profiles.is_active/accounts.is_active (048). O backfill em si
--      (1.3c) não precisou mudar: ele só registra o FATO histórico de
--      participação — quem hoje tem ou não acesso passou a depender da
--      membership ATUAL, avaliada em tempo de leitura pela policy, não
--      mais da mera presença da linha. Ver comentário em 3.3 para o
--      raciocínio completo e os testes 3/16/17/32-34 no checklist.
--
-- Decisão de arquitetura (aprovada em rodadas de auditoria
-- anteriores, não redesenhada nesta revisão):
--   - internal_tickets.account_id continua sendo a unidade de
--     ORIGEM/dona do chamado — nunca alterado por esta migration,
--     continua imutável (guard de 052, seção 2.10, inalterado).
--   - internal_tickets.target_account_id (NOVO, nullable) é a
--     unidade de DESTINO. NULL = chamado local, comportamento
--     idêntico ao pré-065. Preenchido = chamado encaminhado. Mutável
--     só por current_user = 'postgres' (hardening 2 acima).
--   - type_id/status_id/stage_id/internal_company_id/created_by
--     continuam catálogo/autoria da ORIGEM, sempre — nunca migram
--     para o destino.
--   - team_id/assigned_user_id validam contra a conta EFETIVA =
--     COALESCE(target_account_id, account_id).
--   - internal_ticket_account_links controla QUAIS encaminhamentos
--     são permitidos — consultado só no MOMENTO de um novo
--     encaminhamento (RPC da 066), NUNCA pela RLS de visibilidade de
--     tickets/comments/events. Desativar um link não apaga acesso a
--     chamados já encaminhados.
--   - internal_ticket_participants registra, de forma append-only,
--     todo usuário que teve envolvimento legítimo e real com o
--     chamado. Participante é relação usuário<->chamado — nunca
--     grava account_id (ver seção 1.3 para o raciocínio completo).
--     Concede VIEW permanente, nunca UPDATE.
--
-- O que esta migration NÃO faz (fica para 066, ou fases futuras):
--   - Nenhuma RPC operacional nova (create_internal_ticket,
--     update_internal_ticket, add_internal_ticket_comment não são
--     tocadas aqui — continuam exatamente como a 054 deixou).
--   - Nenhuma RPC forward_internal_ticket, nenhuma RPC de gestão de
--     internal_ticket_account_links — INSERT/UPDATE nas duas tabelas
--     novas ficam default-deny para `authenticated` até a 066.
--   - Nenhuma notification nova — fica para 067.
--   - Nenhuma mudança de UI/TypeScript.
--
-- NÃO edita 052/053/054/062/063/064 — só CREATE OR REPLACE de
-- funções já existentes (mesmo padrão que 063->064 já usou) e
-- ADD COLUMN/CREATE TABLE novos. Sem DROP TABLE, sem DELETE, sem
-- backfill destrutivo.
--
-- IDEMPOTÊNCIA (afirmação precisa, não genérica — ver item 19 da
-- auditoria desta rodada): todo statement individual deste arquivo é
-- seguro para reexecutar depois de uma execução anterior que tenha
-- COMPLETADO com sucesso, ou que tenha FALHADO limpo (nada
-- parcialmente aplicado). ADD COLUMN/CREATE TABLE/CREATE INDEX usam
-- IF NOT EXISTS; CREATE OR REPLACE FUNCTION substitui inteiro;
-- DROP TRIGGER/POLICY IF EXISTS + CREATE recria do zero;
-- REVOKE/GRANT são no-op quando já aplicados; o bloco de
-- event_type (seção 1.4) localiza a constraint pelo conteúdo real
-- (não por nome assumido) e converge para o mesmo estado em
-- reexecuções. ÚNICA RESSALVA REAL: CREATE TABLE IF NOT EXISTS NÃO
-- reconcilia uma tabela que já existe com formato DIFERENTE do
-- definido aqui (ex.: alguém alterou manualmente
-- internal_ticket_participants entre duas aplicações desta
-- migration) — nesse cenário específico (fora do fluxo normal de
-- deploy) o comando é ignorado silenciosamente, sem erro E sem
-- corrigir a divergência. O checklist no rodapé inclui uma
-- verificação estrutural explícita para isso.
-- ============================================================

-- ============================================================
-- 1. SCHEMA
-- ============================================================

-- ---- 1.1 internal_tickets.target_account_id ------------------------
-- Nullable, sem backfill: todo chamado existente fica com
-- target_account_id = NULL automaticamente — comportamento local
-- pré-065 preservado por construção, sem UPDATE em massa.
--
-- Continua FORA da lista de colunas protegidas por
-- internal_prevent_immutable_column_change (052, seção 2.10) —
-- precisa continuar mutável — mas ganha proteção PRÓPRIA e mais
-- restrita via internal_tickets_guard_target_account_id (seção 2.2):
-- mutável só por current_user = 'postgres', nunca por
-- authenticated/service_role/qualquer role de cliente.
ALTER TABLE internal_tickets
  ADD COLUMN IF NOT EXISTS target_account_id UUID NULL REFERENCES accounts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_tickets_target_not_self'
  ) THEN
    ALTER TABLE internal_tickets
      ADD CONSTRAINT internal_tickets_target_not_self
      CHECK (target_account_id IS NULL OR target_account_id <> account_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_internal_tickets_target_account
  ON internal_tickets(target_account_id) WHERE target_account_id IS NOT NULL;

-- ---- 1.2 internal_ticket_account_links ------------------------------
-- Vínculo DIRECIONAL entre duas accounts, autorizando encaminhamento
-- de Chamados Internos de source_account_id para target_account_id.
-- A->B autorizado NÃO implica B->A. Gestão (INSERT/UPDATE) fica para
-- uma RPC platform_admin-only na 066.
CREATE TABLE IF NOT EXISTS internal_ticket_account_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account_id <> target_account_id),
  UNIQUE (source_account_id, target_account_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_account_links_source
  ON internal_ticket_account_links(source_account_id);
CREATE INDEX IF NOT EXISTS idx_internal_ticket_account_links_target
  ON internal_ticket_account_links(target_account_id);

ALTER TABLE internal_ticket_account_links ENABLE ROW LEVEL SECURITY;

-- ---- 1.2b internal_ticket_account_links — privilégios de tabela ----
-- EXPLÍCITO (hardening desta rodada, ver cabeçalho item 6): toda
-- tabela nova em `public` recebe, por padrão de projeto Supabase (não
-- por nenhuma migration deste repositório — auditado, ver retorno),
-- GRANT amplo para anon/authenticated/service_role. Sem este bloco, a
-- única coisa impedindo authenticated de tentar INSERT/UPDATE/DELETE
-- aqui seria a ausência de policy (RLS default-deny) — funciona, mas
-- fica implícito/silencioso. REVOKE explícito + GRANT SELECT pontual
-- torna as duas camadas (GRANT decide se a operação pode ser
-- tentada; RLS decide quais linhas) auditáveis por leitura direta
-- desta migration, sem depender de conhecer os defaults da
-- plataforma. Mesmo padrão já usado por platform_admins/
-- platform_audit_log (046_platform_admin_foundation.sql).
REVOKE ALL ON TABLE internal_ticket_account_links FROM PUBLIC;
REVOKE ALL ON TABLE internal_ticket_account_links FROM anon;
REVOKE ALL ON TABLE internal_ticket_account_links FROM authenticated;
-- SELECT é reconcedido a `authenticated` pontualmente — a RLS da
-- seção 3.2 é quem de fato restringe a admin/owner de qualquer um
-- dos dois lados. Sem INSERT/UPDATE/DELETE para authenticated nesta
-- migration — gestão é 100% RPC platform_admin-only na 066.
GRANT SELECT ON TABLE internal_ticket_account_links TO authenticated;
-- service_role NÃO é tocado por este bloco: mantém os privilégios
-- padrão da plataforma — service_role já é um role de confiança em
-- todo o restante do projeto (várias rotas usam supabaseAdmin() com
-- INSERT/UPDATE diretos em tabelas internal_*, ex.: POST
-- /api/internal-tickets/teams), revogar dele aqui quebraria esse
-- padrão sem ganho real de segurança (uma service_role
-- key comprometida já compromete o banco inteiro, não só esta
-- tabela). postgres (owner) nunca é afetado por REVOKE/GRANT.

-- update_updated_at_column() já existe (001_initial_schema.sql) — só
-- vinculada aqui, não recriada (mesmo padrão de 052, seção 2.1).
DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_account_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_account_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 1.3 internal_ticket_participants -------------------------------
-- Relação usuário<->chamado, DELIBERADAMENTE sem account_id: a conta
-- do participante não é armazenada — a legitimidade já foi validada
-- no MOMENTO do registro (seção 2.4/2.5) via EXISTS explícito contra
-- profiles, nunca assumindo 1 linha por usuário. Sem a coluna, esta
-- tabela fica compatível por construção com um futuro membership N:N
-- usuário<->account.
--
-- Append-only, sem soft-delete: participação é fato histórico
-- permanente (mesma filosofia de internal_ticket_events).
CREATE TABLE IF NOT EXISTS internal_ticket_participants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, user_id)
);

-- O índice único (ticket_id, user_id) já cobre lookups por ticket_id
-- (prefixo esquerdo) — o índice abaixo cobre o sentido por user_id.
CREATE INDEX IF NOT EXISTS idx_internal_ticket_participants_user
  ON internal_ticket_participants(user_id);

ALTER TABLE internal_ticket_participants ENABLE ROW LEVEL SECURITY;

-- ---- 1.3b internal_ticket_participants — privilégios de tabela -----
-- Mesmo racional da 1.2b. SELECT reconcedido pontualmente — a RLS da
-- seção 3.1 restringe a apenas a própria linha do usuário. Sem
-- INSERT/UPDATE/DELETE para authenticated — escrita é exclusiva dos
-- 2 triggers da seção 2.4/2.5 (SECURITY DEFINER, owner postgres, que
-- ignora RLS e não depende de nenhum GRANT de tabela para funcionar).
REVOKE ALL ON TABLE internal_ticket_participants FROM PUBLIC;
REVOKE ALL ON TABLE internal_ticket_participants FROM anon;
REVOKE ALL ON TABLE internal_ticket_participants FROM authenticated;
GRANT SELECT ON TABLE internal_ticket_participants TO authenticated;

-- ---- 1.3c internal_ticket_participants — backfill histórico ---------
-- BLOQUEADOR FUNCIONAL corrigido nesta rodada (2ª revisão externa):
-- os triggers 2.5/2.6 (seção 2) só capturam participação NOVA, criada
-- depois desta migration — sem backfill, todo created_by/assigned_
-- user_id/actor_user_id/author_id ANTERIOR à 065 fica sem linha em
-- internal_ticket_participants. Isso quebraria a perna 3/3 do SELECT
-- (3.3/3.5/3.7) especificamente para tickets já existentes quando
-- encaminhados pela futura 066 — exatamente o cenário coberto pelos
-- itens 16/17 do checklist no rodapé deste arquivo.
--
-- ORDEM: roda aqui — depois de CREATE TABLE (1.3) e dos grants (1.3b),
-- ANTES de qualquer trigger forward-looking (2.5/2.6, seção 2). Não
-- há motivo para esperar as policies de RLS (seção 3): a migration
-- inteira roda como owner/superuser (ver nota abaixo), então a ordem
-- relativa ao RLS não muda o resultado — mas rodar antes das seções
-- 2/3 deixa claro, por leitura sequencial do arquivo, que este é um
-- passo de dados histórico e único, não mais um trigger.
--
-- FONTES (UNION ALL de 4 origens; cada usuário só entra 1x por
-- ticket, com o timestamp MAIS ANTIGO entre todas as fontes em que
-- aparece — ver GROUP BY/MIN abaixo):
--   A. created_by            — timestamp = internal_tickets.created_at
--   B. assigned_user_id      — timestamp = primeiro evento
--      'assignee_changed' cujo to_value bate com esse usuário (dado
--      já gravado por update_internal_ticket desde 054: to_value =
--      NEW.assigned_user_id::text); se não existir esse evento (ex.:
--      atribuição herdada de antes de 052-INT-C existir, ou qualquer
--      lacuna de dado legado), cai em created_at do ticket como limite
--      inferior seguro — o usuário não pode ter sido responsável antes
--      do ticket existir. Fallback documentado conforme pedido, para
--      não tornar o SQL mais complexo do que uma subquery correlata
--      simples.
--   C. internal_ticket_events.actor_user_id (quando não-null) —
--      timestamp = internal_ticket_events.created_at.
--   D. internal_ticket_comments.author_id — timestamp =
--      internal_ticket_comments.created_at.
--
-- DELIBERADAMENTE NÃO incluído: internal_team_members. Ser membro de
-- uma equipe sem nunca ter criado/comentado/gerado evento/sido
-- responsável não é participação real — só um snapshot de membership,
-- que já tem sua própria perna de visibilidade (SELECT, pernas 1/2 de
-- 3.3) e não deve virar VIEW permanente via participants.
--
-- TENANCY / INTEGRIDADE DE DADO LEGADO: nenhum filtro defensivo extra
-- é necessário além de "IS NOT NULL" nas colunas nullable (B, C). Para
-- A (created_by) e D (author_id), as colunas são NOT NULL com FK
-- ON DELETE RESTRICT para auth.users (052) — o próprio Postgres já
-- torna impossível existir uma linha com created_by/author_id
-- apontando para um usuário inexistente; não há "registro legado
-- inconsistente" possível de vir dessas duas colunas para o backfill
-- falhar. Para B (assigned_user_id, FK ON DELETE SET NULL) e C
-- (actor_user_id, FK ON DELETE SET NULL), o único estado "inválido"
-- possível é NULL — já coberto pelo WHERE de cada fonte. Nenhum
-- registro individual pode fazer este backfill abortar.
--
-- IDEMPOTÊNCIA: INSERT puro com ON CONFLICT (ticket_id, user_id) DO
-- NOTHING — reexecução não duplica linha nem sobrescreve first_seen_at
-- já gravado (nem por este backfill, nem por 2.5/2.6). Nenhum UPDATE
-- em internal_ticket_participants existe neste arquivo.
--
-- RLS: irrelevante para este bloco — migrations rodam como o role
-- owner/superuser da conexão de migração (postgres), que sempre
-- ignora RLS independentemente de existir policy ou não (mesmo motivo
-- por que os triggers SECURITY DEFINER desta migration conseguem ler
-- profiles/internal_teams sem policy própria). Nenhuma policy
-- temporária foi criada nem é necessária.
INSERT INTO internal_ticket_participants (ticket_id, user_id, first_seen_at)
SELECT ticket_id, user_id, MIN(participated_at)
FROM (
  -- A. criador
  SELECT it.id AS ticket_id, it.created_by AS user_id, it.created_at AS participated_at
  FROM internal_tickets it

  UNION ALL

  -- B. responsável atual (com fallback documentado acima)
  SELECT
    it.id AS ticket_id,
    it.assigned_user_id AS user_id,
    COALESCE(
      (SELECT MIN(ev.created_at)
       FROM internal_ticket_events ev
       WHERE ev.ticket_id = it.id
         AND ev.event_type = 'assignee_changed'
         AND ev.to_value = it.assigned_user_id::text),
      it.created_at
    ) AS participated_at
  FROM internal_tickets it
  WHERE it.assigned_user_id IS NOT NULL

  UNION ALL

  -- C. ator de qualquer evento histórico
  SELECT ev.ticket_id, ev.actor_user_id AS user_id, ev.created_at AS participated_at
  FROM internal_ticket_events ev
  WHERE ev.actor_user_id IS NOT NULL

  UNION ALL

  -- D. autor de comentário histórico
  SELECT c.ticket_id, c.author_id AS user_id, c.created_at AS participated_at
  FROM internal_ticket_comments c
) historical_participation
GROUP BY ticket_id, user_id
ON CONFLICT (ticket_id, user_id) DO NOTHING;

-- ---- 1.4 internal_ticket_events.event_type — novo valor -------------
-- Expande o CHECK existente (052, seção 1.10) para incluir
-- 'target_account_changed'. Os 12 valores já existentes são
-- preservados integralmente; nenhum evento existente é afetado
-- (ALTER de CHECK não reescreve linhas).
--
-- ROBUSTO A NOME DESCONHECIDO (hardening desta rodada): em vez de
-- assumir o nome padrão que o Postgres atribui a um CHECK de coluna
-- sem nome explícito (internal_ticket_events_event_type_check — pode
-- divergir se o ambiente real nomeou diferente por qualquer motivo),
-- localiza a constraint pelo conteúdo real via pg_get_constraintdef
-- (sempre populado para CHECK, ao contrário de pg_constraint.conkey,
-- que nem sempre é confiável para constraints de coluna). Se não
-- encontrar NENHUMA constraint CHECK mencionando event_type, ABORTA
-- com uma mensagem clara em vez de seguir em frente e potencialmente
-- deixar duas constraints divergentes convivendo (a antiga, não
-- removida, continuaria rejeitando 'target_account_changed' mesmo
-- com a nova constraint criada). Idempotente: numa segunda execução,
-- a busca encontra a própria constraint que este bloco criou da
-- primeira vez (sua definição também menciona "event_type"), dropa e
-- recria identicamente.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.internal_ticket_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_type%';

  IF v_conname IS NULL THEN
    RAISE EXCEPTION 'Could not locate the CHECK constraint on internal_ticket_events.event_type — aborting to avoid a divergent/duplicate constraint. Inspect pg_constraint manually before reapplying this migration.';
  END IF;

  EXECUTE format('ALTER TABLE internal_ticket_events DROP CONSTRAINT %I', v_conname);

  ALTER TABLE internal_ticket_events
    ADD CONSTRAINT internal_ticket_events_event_type_check
    CHECK (event_type IN (
      'created', 'title_changed', 'description_changed', 'type_changed',
      'status_changed', 'stage_changed', 'team_changed', 'assignee_changed',
      'company_changed', 'scheduled_at_changed', 'comment_added',
      'completed', 'cancelled', 'target_account_changed'
    ));
END $$;

-- ============================================================
-- 2. FUNÇÕES E TRIGGERS
-- ============================================================

-- ---- 2.1 internal_tickets_validate_tenancy() (CREATE OR REPLACE) ----
-- Mesma função de 052 (seção 2.3), com duas mudanças:
--   (a) team_id/assigned_user_id validam contra a conta EFETIVA
--       (COALESCE(target_account_id, account_id)) em vez de sempre
--       account_id. type_id/status_id/stage_id/internal_company_id/
--       created_by permanecem sempre contra account_id (origem).
--   (b) HARDENING desta rodada: assigned_user_id/created_by não usam
--       mais "SELECT account_id FROM profiles WHERE user_id = X"
--       (pressupõe 1 linha) — cada checagem é um EXISTS explícito
--       filtrando por (user_id, account_id) juntos, com mensagens de
--       erro distintas preservadas (não encontrado / conta errada /
--       inativo), compatível por construção com um futuro profiles
--       N:N.
CREATE OR REPLACE FUNCTION public.internal_tickets_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type_account      UUID;
  v_status_account     UUID;
  v_stage_account      UUID;
  v_team_account       UUID;
  v_company_account    UUID;
  v_effective_account  UUID;
BEGIN
  v_effective_account := COALESCE(NEW.target_account_id, NEW.account_id);

  SELECT account_id INTO v_type_account FROM internal_ticket_types WHERE id = NEW.type_id;
  IF v_type_account IS NOT NULL AND v_type_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_tickets.type_id must reference a type in the same account';
  END IF;

  SELECT account_id INTO v_status_account FROM internal_ticket_statuses WHERE id = NEW.status_id;
  IF v_status_account IS NOT NULL AND v_status_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_tickets.status_id must reference a status in the same account';
  END IF;

  IF NEW.stage_id IS NOT NULL THEN
    SELECT account_id INTO v_stage_account FROM internal_ticket_stages WHERE id = NEW.stage_id;
    IF v_stage_account IS NOT NULL AND v_stage_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.stage_id must reference a stage in the same account';
    END IF;
  END IF;

  -- team_id: 065 — conta EFETIVA. internal_teams não é uma tabela de
  -- membership de usuário (é uma linha única por PK), então não se
  -- aplica aqui o mesmo cuidado de "não presumir 1 linha por
  -- usuário" — team_id -> internal_teams.id é sempre 1:1 por
  -- definição de chave primária.
  IF NEW.team_id IS NOT NULL THEN
    SELECT account_id INTO v_team_account FROM internal_teams WHERE id = NEW.team_id;
    IF v_team_account IS NOT NULL AND v_team_account <> v_effective_account THEN
      RAISE EXCEPTION 'internal_tickets.team_id must reference a team in the effective account (origin, or target when forwarded)';
    END IF;
  END IF;

  IF NEW.internal_company_id IS NOT NULL THEN
    SELECT account_id INTO v_company_account FROM internal_companies WHERE id = NEW.internal_company_id;
    IF v_company_account IS NOT NULL AND v_company_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.internal_company_id must reference a company in the same account';
    END IF;
  END IF;

  -- assigned_user_id: 065 — conta EFETIVA + membership explícita
  -- (user_id + account_id juntos), nunca "a conta do usuário" solta.
  IF NEW.assigned_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.assigned_user_id) THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference a profile';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = NEW.assigned_user_id AND account_id = v_effective_account
    ) THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference a profile in the effective account (origin, or target when forwarded)';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = NEW.assigned_user_id AND account_id = v_effective_account AND is_active
    ) THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference an active profile';
    END IF;
  END IF;

  -- created_by: mesma técnica, sempre contra NEW.account_id (origem),
  -- só em INSERT (coluna imutável depois disso).
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.created_by) THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference a profile';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = NEW.created_by AND account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference a profile in the same account';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = NEW.created_by AND account_id = NEW.account_id AND is_active
    ) THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference an active profile';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_tickets_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_tickets_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

-- target_account_id ENTRA na lista de colunas que disparam o
-- trigger: uma mudança que toque SÓ target_account_id precisa
-- revalidar se o team_id/assigned_user_id ATUAIS continuam válidos
-- contra a nova conta efetiva.
DROP TRIGGER IF EXISTS validate_tenancy ON internal_tickets;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT OR UPDATE OF type_id, status_id, stage_id, team_id,
    internal_company_id, assigned_user_id, target_account_id
  ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION public.internal_tickets_validate_tenancy();

-- ---- 2.2 internal_tickets_guard_target_account_id() (NOVA) ----------
-- HARDENING desta rodada (bloqueador #1 encontrado na revisão
-- externa): sem este guard, um admin/owner da ORIGEM (que sempre tem
-- UPDATE irrestrito sobre o próprio chamado, incondicionalmente, na
-- policy internal_tickets_update) poderia, via um UPDATE direto pelo
-- client Supabase/PostgREST, setar target_account_id para QUALQUER
-- account existente — inclusive uma sem NENHUM vínculo autorizado em
-- internal_ticket_account_links. A checagem de link só vai existir
-- dentro da RPC forward_internal_ticket (066); até lá — e mesmo
-- depois, como defesa em profundidade — este trigger garante que
-- SÓ um caller executando como postgres pode mudar target_account_id
-- depois da criação.
--
-- CORREÇÃO (2ª revisão externa, pós-primeira versão desta migration):
-- este trigger precisa ser SECURITY INVOKER, NÃO SECURITY DEFINER.
--
-- SECURITY DEFINER troca current_user para o OWNER da função pela
-- duração inteira da execução — inclusive DENTRO do próprio corpo da
-- função que faz a checagem. A primeira versão deste guard era
-- SECURITY DEFINER OWNER TO postgres: nesse caso, o current_user LIDO
-- DENTRO DO PRÓPRIO GUARD já era sempre 'postgres', não importa quem
-- disparou o UPDATE (authenticated, service_role, ou a futura RPC) —
-- a condição `current_user <> 'postgres'` nunca era verdadeira, e a
-- exceção nunca era lançada. O guard existia mas não bloqueava nada
-- — é o erro clássico de usar current_user para "descobrir quem
-- chamou" dentro de uma função que ela mesma troca o current_user.
--
-- Com SECURITY INVOKER (default; mantido explícito aqui só por
-- documentação), a função NÃO troca current_user — ela lê o role que
-- já estava em vigor no momento em que o UPDATE disparou o trigger:
--   - UPDATE direto via PostgREST como `authenticated`: current_user
--     = 'authenticated' no instante do trigger -> bloqueado (42501).
--   - UPDATE direto via supabaseAdmin() (service_role), sem passar
--     pela RPC: current_user = 'service_role' -> também bloqueado.
--     Isso é intencional: nem o próprio backend deve conseguir mudar
--     target_account_id fora da RPC — força TODA mudança a passar
--     pela validação de link da 066, mesmo para código server-side.
--   - UPDATE que NÃO toca target_account_id (ex.: só title): o
--     trigger é BEFORE UPDATE OF target_account_id, então nem
--     dispara — permitido normalmente, para qualquer role que já
--     passe pela policy de UPDATE (3.4).
--   - A futura forward_internal_ticket (066): SECURITY DEFINER,
--     OWNER TO postgres (mesmo padrão de TODAS as RPCs deste módulo
--     desde 052/054) -> já trocou current_user para 'postgres' ANTES
--     do UPDATE interno rodar; o guard (agora INVOKER) simplesmente
--     herda esse current_user já vigente no momento do UPDATE ->
--     permitido.
--   - create_internal_ticket (054): só faz INSERT, nunca UPDATE de
--     target_account_id — este guard só dispara em UPDATE, então é
--     irrelevante para ela.
--
-- OWNER TO postgres é mantido mesmo com SECURITY INVOKER — owner e
-- SECURITY DEFINER/INVOKER são independentes. Owner só decide quem
-- pode ALTER/DROP a função (mesmo padrão administrativo das outras
-- funções deste módulo); sozinho, owner NUNCA troca current_user
-- durante a execução — só SECURITY DEFINER faz isso. É exatamente
-- essa independência que corrige o bug: continuar owned by postgres
-- não reintroduz o problema, porque a função deixou de ser DEFINER.
--
-- EXECUTE continua revogado de PUBLIC/anon/authenticated/service_role
-- — nenhum GRANT novo é necessário. Um trigger dispara automaticamente
-- em resposta a UPDATE na tabela; o role que fez o UPDATE não precisa
-- de EXECUTE direto sobre a função de trigger para isso acontecer —
-- mesmo mecanismo que já vale, sem exceção, para os outros 5 triggers
-- deste arquivo, independente de SECURITY DEFINER/INVOKER.
--
-- Escopo do trigger: só BEFORE UPDATE OF target_account_id — não
-- precisa cobrir INSERT porque internal_tickets NÃO TEM nenhuma
-- policy de INSERT para authenticated (052, "Sem policy de INSERT" —
-- criação já é 100% impossível fora de uma RPC SECURITY DEFINER,
-- independente deste guard).
CREATE OR REPLACE FUNCTION public.internal_tickets_guard_target_account_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.target_account_id IS DISTINCT FROM OLD.target_account_id
     AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'internal_tickets.target_account_id can only be changed by a trusted SECURITY DEFINER function (forward_internal_ticket)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_tickets_guard_target_account_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_tickets_guard_target_account_id() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_target_account_id ON internal_tickets;
CREATE TRIGGER guard_target_account_id
  BEFORE UPDATE OF target_account_id ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION public.internal_tickets_guard_target_account_id();

-- ---- 2.3 internal_ticket_comments_validate_tenancy() (CREATE OR REPLACE) ----
-- Mesma função de 052 (seção 2.4). author_id/deleted_by aceitam um
-- profile da conta de ORIGEM **ou** da conta de DESTINO atual do
-- ticket (nunca uma terceira). account_id do comentário em si
-- continua sempre = account_id de origem do ticket. HARDENING desta
-- rodada: membership validada via EXISTS explícito (user_id +
-- account_id), nunca "a conta do usuário" sem filtro — mesmo
-- racional da seção 2.1.
CREATE OR REPLACE FUNCTION public.internal_ticket_comments_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account    UUID;
  v_ticket_target     UUID;
  v_check_deleted_by  BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT account_id, target_account_id INTO v_ticket_account, v_ticket_target
    FROM internal_tickets WHERE id = NEW.ticket_id;
    IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_ticket_comments.ticket_id must reference a ticket in the same account';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.author_id) THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference a profile';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.author_id AND account_id = v_ticket_account)
      OR (v_ticket_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM profiles WHERE user_id = NEW.author_id AND account_id = v_ticket_target
      ))
    ) THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference a profile in the ticket''s origin or target account';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.author_id AND account_id = v_ticket_account AND is_active)
      OR (v_ticket_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM profiles WHERE user_id = NEW.author_id AND account_id = v_ticket_target AND is_active
      ))
    ) THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference an active profile';
    END IF;

    v_check_deleted_by := NEW.deleted_by IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_check_deleted_by := NEW.deleted_by IS NOT NULL AND NEW.deleted_by IS DISTINCT FROM OLD.deleted_by;
    IF v_check_deleted_by THEN
      -- ticket_id/account_id do comentário são imutáveis, mas o
      -- target_account_id do TICKET pode ter mudado desde o INSERT
      -- do comentário — busca sempre o estado atual do ticket.
      SELECT account_id, target_account_id INTO v_ticket_account, v_ticket_target
      FROM internal_tickets WHERE id = NEW.ticket_id;
    END IF;
  END IF;

  IF v_check_deleted_by THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.deleted_by) THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference a profile';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.deleted_by AND account_id = v_ticket_account)
      OR (v_ticket_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM profiles WHERE user_id = NEW.deleted_by AND account_id = v_ticket_target
      ))
    ) THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference a profile in the ticket''s origin or target account';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.deleted_by AND account_id = v_ticket_account AND is_active)
      OR (v_ticket_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM profiles WHERE user_id = NEW.deleted_by AND account_id = v_ticket_target AND is_active
      ))
    ) THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference an active profile';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_ticket_comments_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_ticket_comments_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

-- Binding do trigger inalterado desde 052 (mesma lista de colunas).
DROP TRIGGER IF EXISTS validate_tenancy ON internal_ticket_comments;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT OR UPDATE OF deleted_by ON internal_ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.internal_ticket_comments_validate_tenancy();

-- ---- 2.4 internal_ticket_events_validate_tenancy() (CREATE OR REPLACE) ----
-- Mesma função de 052 (seção 2.5). actor_user_id aceita profile da
-- origem OU do destino atual. Comportamento histórico para
-- actor_user_id NULL (nenhuma checagem) e ausência de checagem de
-- is_active (evento é registro histórico, não afirmação presente)
-- preservados sem alteração. HARDENING desta rodada: membership via
-- EXISTS explícito, mesmo racional das seções 2.1/2.3.
CREATE OR REPLACE FUNCTION public.internal_ticket_events_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account UUID;
  v_ticket_target  UUID;
BEGIN
  SELECT account_id, target_account_id INTO v_ticket_account, v_ticket_target
  FROM internal_tickets WHERE id = NEW.ticket_id;
  IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_ticket_events.ticket_id must reference a ticket in the same account';
  END IF;

  IF NEW.actor_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.actor_user_id) THEN
      RAISE EXCEPTION 'internal_ticket_events.actor_user_id must reference a profile';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.actor_user_id AND account_id = v_ticket_account)
      OR (v_ticket_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM profiles WHERE user_id = NEW.actor_user_id AND account_id = v_ticket_target
      ))
    ) THEN
      RAISE EXCEPTION 'internal_ticket_events.actor_user_id must reference a profile in the ticket''s origin or target account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_ticket_events_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_ticket_events_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_tenancy ON internal_ticket_events;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT ON internal_ticket_events
  FOR EACH ROW EXECUTE FUNCTION public.internal_ticket_events_validate_tenancy();

-- ---- 2.5 internal_ticket_events_record_participant() (NOVA) ---------
-- Deriva internal_ticket_participants a partir de internal_ticket_
-- events: todo evento com actor_user_id conhecido credita esse ator
-- como participante permanente. Já usava EXISTS explícito por
-- origem/destino desde a primeira versão desta migration — mantido
-- sem alteração nesta rodada (auditoria confirmou que já seguia o
-- padrão pedido).
CREATE OR REPLACE FUNCTION public.internal_ticket_events_record_participant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account UUID;
  v_ticket_target  UUID;
  v_legit          BOOLEAN;
BEGIN
  IF NEW.actor_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id, target_account_id INTO v_ticket_account, v_ticket_target
  FROM internal_tickets WHERE id = NEW.ticket_id;

  IF v_ticket_account IS NULL THEN
    RETURN NEW;
  END IF;

  v_legit := EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = NEW.actor_user_id AND account_id = v_ticket_account
  ) OR (
    v_ticket_target IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = NEW.actor_user_id AND account_id = v_ticket_target
    )
  );

  IF v_legit THEN
    INSERT INTO internal_ticket_participants (ticket_id, user_id)
    VALUES (NEW.ticket_id, NEW.actor_user_id)
    ON CONFLICT (ticket_id, user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_ticket_events_record_participant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_ticket_events_record_participant() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS record_participant ON internal_ticket_events;
CREATE TRIGGER record_participant
  AFTER INSERT ON internal_ticket_events
  FOR EACH ROW EXECUTE FUNCTION public.internal_ticket_events_record_participant();

-- ---- 2.6 internal_tickets_record_assignee_participant() (NOVA) ------
-- Credita o NOVO responsável (assigned_user_id) como participante
-- permanente, independentemente de quem realizou a atribuição. Fires
-- AFTER INSERT OR UPDATE OF assigned_user_id — sempre depois do
-- trigger validate_tenancy (BEFORE, seção 2.1), que agora (hardening
-- desta rodada) já garante via EXISTS explícito que assigned_user_id
-- pertence à conta efetiva. Por isso este trigger continua sem
-- revalidar — a tenancy do próprio ticket já é a autoridade.
CREATE OR REPLACE FUNCTION public.internal_tickets_record_assignee_participant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO internal_ticket_participants (ticket_id, user_id)
  VALUES (NEW.id, NEW.assigned_user_id)
  ON CONFLICT (ticket_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_tickets_record_assignee_participant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_tickets_record_assignee_participant() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS record_assignee_participant ON internal_tickets;
CREATE TRIGGER record_assignee_participant
  AFTER INSERT OR UPDATE OF assigned_user_id ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION public.internal_tickets_record_assignee_participant();

-- ============================================================
-- 3. RLS
-- ============================================================

-- ---- 3.1 internal_ticket_participants --------------------------------
-- Necessário mesmo com o pedido original de "zero policies": uma
-- policy de OUTRA tabela (internal_tickets_select/comments_select/
-- events_select) que referencia esta tabela via EXISTS só enxerga
-- linhas que a RLS DESTA tabela permitir para o role em execução —
-- RLS é avaliada por tabela mesmo quando lida de dentro da policy de
-- outra (mesmo mecanismo que já faz o EXISTS contra
-- internal_team_members funcionar hoje). Sem NENHUMA policy aqui, a
-- perna de participante ficaria permanentemente morta. A policy
-- abaixo é o mínimo necessário: cada usuário só enxerga as PRÓPRIAS
-- linhas. Sem policy de INSERT/UPDATE/DELETE — escrita exclusiva
-- pelos triggers 2.5/2.6 (SECURITY DEFINER, ignora RLS).
DROP POLICY IF EXISTS internal_ticket_participants_select ON internal_ticket_participants;
CREATE POLICY internal_ticket_participants_select ON internal_ticket_participants FOR SELECT
  USING (user_id = auth.uid());

-- ---- 3.2 internal_ticket_account_links -------------------------------
-- SELECT restrito a admin/owner de qualquer um dos dois lados. Sem
-- policy de INSERT/UPDATE/DELETE — default-deny total para
-- `authenticated` até a RPC de gestão da 066 existir.
DROP POLICY IF EXISTS internal_ticket_account_links_select ON internal_ticket_account_links;
CREATE POLICY internal_ticket_account_links_select ON internal_ticket_account_links FOR SELECT
  USING (
    is_account_member(source_account_id, 'admin')
    OR is_account_member(target_account_id, 'admin')
  );

-- ---- 3.3 internal_tickets — SELECT (CREATE OR REPLACE) --------------
-- 3 pernas: origem (idêntica ao pré-065), destino (só quando
-- target_account_id preenchido), participante histórico. SELECT
-- continua cross-account — só o UPDATE (seção 3.4) foi recuado nesta
-- rodada (Option A da revisão).
--
-- SEM helper compartilhado nesta v1 (decisão explícita mantida): a
-- condição abaixo é reescrita, sem abstração, também em
-- internal_ticket_comments_select e internal_ticket_events_select
-- (seções 3.5/3.7) — qualquer mudança precisa ser replicada
-- manualmente. Comentário de sincronização repetido em cada uma.
DROP POLICY IF EXISTS internal_tickets_select ON internal_tickets;
CREATE POLICY internal_tickets_select ON internal_tickets FOR SELECT
  USING (
    -- PERNA 1/3 — ORIGEM (idêntica ao comportamento pré-065, 052).
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id)
      AND (
        created_by = auth.uid()
        OR (target_account_id IS NULL AND assigned_user_id = auth.uid())
        OR (target_account_id IS NULL AND EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid() AND tm.is_active
        ))
      )
    )
    -- PERNA 2/3 — DESTINO (só quando target_account_id preenchido).
    OR (
      target_account_id IS NOT NULL
      AND (
        is_account_member(target_account_id, 'admin')
        OR (
          is_account_member(target_account_id)
          AND (
            assigned_user_id = auth.uid()
            OR EXISTS (
              SELECT 1 FROM internal_team_members tm
              WHERE tm.team_id = internal_tickets.team_id
                AND tm.account_id = internal_tickets.target_account_id
                AND tm.user_id = auth.uid() AND tm.is_active
            )
          )
        )
      )
    )
    -- PERNA 3/3 — PARTICIPANTE (nunca concede UPDATE — ver seção 3.4).
    --
    -- CORREÇÃO (auditoria de segurança pós-revisão externa, achado
    -- CRÍTICO): a versão original desta perna concedia VIEW permanente
    -- só por existir uma linha em internal_ticket_participants,
    -- IGNORANDO se o usuário ainda pertence à conta de origem ou de
    -- destino do chamado. internal_ticket_participants não tem coluna
    -- account_id por design (ver seção 1.3) e profiles.account_id É
    -- MUTÁVEL (um usuário pode ser movido de conta via
    -- create_account_member, 056/062) — sem esta revalidação, alguém
    -- que um dia comentou/foi responsável por um chamado mantinha
    -- acesso de leitura PARA SEMPRE a esse chamado mesmo depois de sair
    -- completamente do tenant, e o backfill (1.3c) populava isso para
    -- todo o histórico existente, tornando o vazamento imediato assim
    -- que esta migration fosse aplicada — independente de qualquer
    -- encaminhamento cross-account existir.
    --
    -- Fix: reusa is_account_member() (mesmo helper já usado nas pernas
    -- 1/3 e 2/3 acima) para exigir participação + associação ATUAL do
    -- chamador a QUALQUER UMA das duas contas legítimas deste chamado
    -- — origem sempre, destino só quando o chamado foi encaminhado.
    -- is_account_member() já checa profiles.is_active e accounts.
    -- is_active (048), então uma conta/perfil desativado também perde
    -- a perna, sem lógica nova. Preserva o comportamento pretendido
    -- (participante continua vendo enquanto for membro legítimo de
    -- origem OU destino — cenário 16 do checklist) e fecha a
    -- permanência indevida (cenário: usuário trocou de conta — perde
    -- acesso, porque deixa de ser membro de account_id/target_account_id
    -- por definição). Não introduz oráculo: o resultado desta perna já
    -- era 0 ou N linhas do mesmo chamado, nunca revela a existência de
    -- linhas de OUTRO chamado ou conta.
    OR (
      is_account_member(internal_tickets.account_id)
      OR (
        internal_tickets.target_account_id IS NOT NULL
        AND is_account_member(internal_tickets.target_account_id)
      )
    ) AND EXISTS (
      SELECT 1 FROM internal_ticket_participants p
      WHERE p.ticket_id = internal_tickets.id AND p.user_id = auth.uid()
    )
  );

-- ---- 3.4 internal_tickets — UPDATE (CREATE OR REPLACE) --------------
-- HARDENING desta rodada (Option A, preferência explícita): esta
-- policy volta a ser TEXTUALMENTE IDÊNTICA à de 052/pré-065— SEM
-- perna de destino e SEM perna de participante. Até a 066 trazer
-- update_internal_ticket estendida + forward_internal_ticket
-- (SECURITY DEFINER, que bypassa RLS e não depende de UPDATE-via-
-- authenticated para funcionar), nenhum usuário do lado destino
-- consegue tocar a linha via client direto — só as RPCs SECURITY
-- DEFINER conseguem (elas já bypassam RLS, então não perdem
-- capacidade nenhuma com este recuo). Fecha a janela de exposição
-- identificada na revisão externa sem esperar pela 066.
DROP POLICY IF EXISTS internal_tickets_update ON internal_tickets;
CREATE POLICY internal_tickets_update ON internal_tickets FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (
        created_by = auth.uid()
        OR assigned_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid()
            AND tm.is_active
        )
      )
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (
        created_by = auth.uid()
        OR assigned_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid()
            AND tm.is_active
        )
      )
    )
  );

-- ---- 3.5 internal_ticket_comments — SELECT ---------------------------
-- Espelha exatamente as 3 pernas de 3.3 (incluindo participante) —
-- SELECT de comentário continua cross-account, mesmo com UPDATE de
-- ticket recuado (visualizar não é a superfície de risco).
--
-- SINCRONIZAÇÃO: mesma condição de 3.3/3.7 — sem helper compartilhado
-- nesta v1.
DROP POLICY IF EXISTS internal_ticket_comments_select ON internal_ticket_comments;
CREATE POLICY internal_ticket_comments_select ON internal_ticket_comments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM internal_tickets t
      WHERE t.id = internal_ticket_comments.ticket_id
        AND t.account_id = internal_ticket_comments.account_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (
            is_account_member(t.account_id)
            AND (
              t.created_by = auth.uid()
              OR (t.target_account_id IS NULL AND t.assigned_user_id = auth.uid())
              OR (t.target_account_id IS NULL AND EXISTS (
                SELECT 1 FROM internal_team_members tm
                WHERE tm.team_id = t.team_id AND tm.account_id = t.account_id
                  AND tm.user_id = auth.uid() AND tm.is_active
              ))
            )
          )
          OR (
            t.target_account_id IS NOT NULL
            AND (
              is_account_member(t.target_account_id, 'admin')
              OR (
                is_account_member(t.target_account_id)
                AND (
                  t.assigned_user_id = auth.uid()
                  OR EXISTS (
                    SELECT 1 FROM internal_team_members tm
                    WHERE tm.team_id = t.team_id AND tm.account_id = t.target_account_id
                      AND tm.user_id = auth.uid() AND tm.is_active
                  )
                )
              )
            )
          )
          -- Perna de participante — mesma correção da 3.3 (ver
          -- comentário lá para o raciocínio completo): revalida
          -- membership ATUAL em origem/destino via is_account_member()
          -- em vez de conceder acesso só por existir a linha histórica
          -- em internal_ticket_participants.
          OR (
            (
              is_account_member(t.account_id)
              OR (t.target_account_id IS NOT NULL AND is_account_member(t.target_account_id))
            ) AND EXISTS (
              SELECT 1 FROM internal_ticket_participants p
              WHERE p.ticket_id = t.id AND p.user_id = auth.uid()
            )
          )
        )
    )
  );

-- ---- 3.6 internal_ticket_comments — INSERT/UPDATE --------------------
-- HARDENING desta rodada (achado #3, ver cabeçalho): a policy
-- internal_ticket_comments_insert é REMOVIDA (não recriada) — a
-- aplicação já usa exclusivamente add_internal_ticket_comment (054,
-- SECURITY DEFINER) para inserir comentários (confirmado lendo
-- src/app/api/internal-tickets/[id]/comments/route.ts: o POST só
-- chama supabaseAdmin().rpc(...), nunca um INSERT direto). Sem
-- policy de INSERT, internal_ticket_comments vira RPC-only, mesmo
-- padrão que internal_ticket_events já tinha desde a fundação (052).
-- Isso fecha o caminho por onde um comentário poderia nascer sem o
-- evento 'comment_added' correspondente (e, por consequência, sem o
-- registro de participante derivado dele).
--
-- A RPC add_internal_ticket_comment não perde nenhuma capacidade com
-- esta remoção — SECURITY DEFINER sempre bypassou RLS, nunca
-- dependeu desta policy para funcionar.
DROP POLICY IF EXISTS internal_ticket_comments_insert ON internal_ticket_comments;

-- internal_ticket_comments_update: HARDENING (achado #4) — volta a
-- ser TEXTUALMENTE IDÊNTICA à 052 (só origem, sem a perna de destino
-- que a primeira versão desta migration tinha adicionado). Não existe
-- hoje NENHUMA rota que exponha edição/soft-delete de comentário
-- (nem origem, nem destino — ver comentário em .../comments/
-- route.ts) — sem ampliar superfície cross-account que nenhum caller
-- usa. Revisitar quando essa rota for construída de fato.
DROP POLICY IF EXISTS internal_ticket_comments_update ON internal_ticket_comments;
CREATE POLICY internal_ticket_comments_update ON internal_ticket_comments FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (author_id = auth.uid() AND is_account_member(account_id, 'agent'))
  )
  WITH CHECK (
    (deleted_by IS NULL OR deleted_by = auth.uid())
    AND (
      is_account_member(account_id, 'admin')
      OR (author_id = auth.uid() AND is_account_member(account_id, 'agent'))
    )
  );

-- ---- 3.7 internal_ticket_events — SELECT -----------------------------
-- Espelha exatamente as 3 pernas de 3.3, incluindo participante. Sem
-- policy de INSERT/UPDATE/DELETE — append-only, escrita exclusiva
-- pelas RPCs (SECURITY DEFINER), mesmo padrão de 054 (inalterado
-- desde a fundação — nunca teve INSERT policy para começo de
-- conversa).
--
-- SINCRONIZAÇÃO: mesma condição de 3.3/3.5 — sem helper compartilhado
-- nesta v1.
DROP POLICY IF EXISTS internal_ticket_events_select ON internal_ticket_events;
CREATE POLICY internal_ticket_events_select ON internal_ticket_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM internal_tickets t
      WHERE t.id = internal_ticket_events.ticket_id
        AND t.account_id = internal_ticket_events.account_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (
            is_account_member(t.account_id)
            AND (
              t.created_by = auth.uid()
              OR (t.target_account_id IS NULL AND t.assigned_user_id = auth.uid())
              OR (t.target_account_id IS NULL AND EXISTS (
                SELECT 1 FROM internal_team_members tm
                WHERE tm.team_id = t.team_id AND tm.account_id = t.account_id
                  AND tm.user_id = auth.uid() AND tm.is_active
              ))
            )
          )
          OR (
            t.target_account_id IS NOT NULL
            AND (
              is_account_member(t.target_account_id, 'admin')
              OR (
                is_account_member(t.target_account_id)
                AND (
                  t.assigned_user_id = auth.uid()
                  OR EXISTS (
                    SELECT 1 FROM internal_team_members tm
                    WHERE tm.team_id = t.team_id AND tm.account_id = t.target_account_id
                      AND tm.user_id = auth.uid() AND tm.is_active
                  )
                )
              )
            )
          )
          -- Perna de participante — mesma correção da 3.3 (ver
          -- comentário lá para o raciocínio completo): revalida
          -- membership ATUAL em origem/destino via is_account_member()
          -- em vez de conceder acesso só por existir a linha histórica
          -- em internal_ticket_participants.
          OR (
            (
              is_account_member(t.account_id)
              OR (t.target_account_id IS NOT NULL AND is_account_member(t.target_account_id))
            ) AND EXISTS (
              SELECT 1 FROM internal_ticket_participants p
              WHERE p.ticket_id = t.id AND p.user_id = auth.uid()
            )
          )
        )
    )
  );

-- ============================================================
-- NOTA SOBRE TRANSAÇÃO (auditoria desta rodada, item 18)
--
-- Nenhum statement deste arquivo é incompatível com rodar dentro de
-- uma transação: não há CREATE INDEX CONCURRENTLY, não há ALTER TYPE
-- ... ADD VALUE (event_type é TEXT+CHECK, não enum), não há VACUUM/
-- REINDEX. O arquivo inteiro PODE ser envolvido em BEGIN;...COMMIT;
-- com segurança.
--
-- NÃO adicionamos BEGIN;/COMMIT; explícitos aqui: nenhuma das outras
-- 64 migrations deste repositório usa esse padrão (auditado — grep
-- por "^BEGIN;"/"^COMMIT;" em supabase/migrations/*.sql não encontra
-- nenhuma ocorrência), e não há supabase/config.toml neste repo para
-- confirmar qual runner efetivamente aplica estas migrations. Dois
-- cenários possíveis, e o mesmo arquivo funciona nos dois: (a) o
-- runner já envolve cada arquivo numa transação implícita (padrão do
-- `supabase db push`/`migration up` da CLI oficial) — adicionar
-- BEGIN/COMMIT aqui criaria uma transação aninhada desnecessária;
-- (b) o runner NÃO envolve automaticamente (ex.: aplicação manual via
-- psql/SQL editor) — neste caso, recomendamos ENVOLVER A CHAMADA
-- MANUALMENTE (`psql -f 065_....sql` dentro de `BEGIN;`/`COMMIT;`
-- explícitos na sessão, ou colar o conteúdo inteiro do arquivo entre
-- BEGIN;/COMMIT; no SQL editor) em vez de embutir isso no arquivo,
-- que precisa continuar aplicável pelos dois métodos sem
-- modificação.
-- ============================================================

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049-054/063).
-- Rodar contra staging, NUNCA produção, antes/depois de aplicar.
-- Nenhum passo abaixo é executado por esta migration.
--
-- ---- Estrutural ----
--  0. internal_tickets.target_account_id existe, nullable, FK para
--     accounts, CHECK internal_tickets_target_not_self presente.
--  0b. internal_ticket_account_links e internal_ticket_participants
--      existem, RLS habilitada nas duas.
--  0c. internal_ticket_participants NÃO tem coluna account_id.
--  0d. Confirmar grants reais das 2 tabelas novas:
--        SELECT grantee, privilege_type FROM information_schema.role_table_grants
--        WHERE table_name IN ('internal_ticket_participants','internal_ticket_account_links')
--          AND grantee IN ('anon','authenticated','PUBLIC');
--      Esperado: só SELECT para authenticated, zero linhas para
--      anon/PUBLIC, zero INSERT/UPDATE/DELETE para authenticated.
--  0e. Confirmar policies presentes (SELECT policyname, cmd FROM
--      pg_policies WHERE tablename IN (...)): internal_tickets tem
--      exatamente 2 (select, update — SEM perna de destino no
--      update); internal_ticket_comments tem exatamente 2 (select,
--      update — SEM policy de insert); internal_ticket_events tem
--      exatamente 1 (select).
--  0f. event_type: SELECT pg_get_constraintdef(oid) FROM
--      pg_constraint WHERE conrelid='internal_ticket_events'::regclass
--      AND contype='c' -> contém os 14 valores, incluindo
--      'target_account_changed'.
--  0g. internal_tickets_guard_target_account_id: SELECT prosecdef,
--      pg_get_userbyid(proowner) FROM pg_proc WHERE proname =
--      'internal_tickets_guard_target_account_id' -> prosecdef = false
--      (SECURITY INVOKER), owner = postgres. Confirmar que NÃO é mais
--      SECURITY DEFINER (prosecdef = true seria o bug da 1ª versão).
--  0h. Backfill de participants rodou: SELECT count(*) FROM
--      internal_ticket_participants -> maior que zero se já existirem
--      tickets/eventos/comentários pré-065 no ambiente (zero é
--      esperado só em banco sem nenhum chamado interno histórico).
--
-- ---- Comportamental — local/compatibilidade (target NULL) ----
--  1. Chamado local continua funcionando exatamente como antes de
--     065 — criador, admin/owner origem, membro da equipe atual
--     veem via SELECT; agent não-envolvido não vê.
--  2. UPDATE de chamado local por agent envolvido continua
--     funcionando via client direto — a policy de UPDATE é
--     textualmente idêntica à pré-065.
--  3. Um usuário que comentou/agiu num chamado LOCAL (target NULL) e
--     depois deixou de ser membro do team_id atual, mas CONTINUA
--     membro ativo da mesma account — continua vendo via perna de
--     participante (extensão consciente sobre o comportamento
--     pré-065). Isso é diferente de trocar de account inteiramente —
--     ver itens 32-34.
--
-- ---- Comportamental — cross-account ----
--  4. Tentar UPDATE direto (client RLS-scoped) em um chamado com
--     target_account_id preenchido, como agent do DESTINO -> agora
--     REJEITADO pela RLS (policy de update voltou a ser origem-only).
--  5. Tentar (via UPDATE direto simulando um admin de ORIGEM
--     autorizado) mudar target_account_id de um chamado -> REJEITADO
--     pelo trigger guard_target_account_id ("can only be changed by
--     a trusted SECURITY DEFINER function"), mesmo sendo admin/owner
--     da origem com UPDATE liberado pela RLS.
--  6. Confirmar que um UPDATE que NÃO toca target_account_id
--     (ex.: só title) continua funcionando normalmente para admin de
--     origem — o guard só dispara quando o valor realmente muda
--     (IS DISTINCT FROM).
--  7. team_id de uma conta C (nem origem, nem destino) -> rejeitado
--     pelo trigger de tenancy ("must reference a team in the
--     effective account").
--  8. assigned_user_id de uma conta C -> rejeitado.
--  9. Membro ativo da equipe atual em B vê o ticket (perna 2 de 3.3),
--     mas NÃO consegue UPDATE direto (perna de destino ausente em
--     3.4).
-- 10. Admin/owner de B vê (perna 2 de 3.3).
-- 11. Criador (conta A) continua vendo depois do encaminhamento
--     (perna 1 de 3.3).
-- 12. Comentário/evento gerado por um usuário de B com actor/author
--     válido é aceito pelos triggers de tenancy (2.3/2.4) quando
--     inserido via RPC (a única via possível agora, ver item 13).
-- 13. Tentar INSERT direto (client RLS-scoped) em
--     internal_ticket_comments -> REJEITADO (sem policy de insert,
--     RLS default-deny). Confirmar que add_internal_ticket_comment
--     (054, SECURITY DEFINER) continua funcionando normalmente
--     apesar disso — ela nunca dependeu desta policy.
-- 14. Comentário/evento com actor/author de uma terceira conta C é
--     rejeitado pelos triggers de tenancy.
-- 15. Participante duplicado: mesmo usuário gera 2+ eventos no mesmo
--     ticket -> só 1 linha em internal_ticket_participants,
--     first_seen_at não muda na 2ª vez.
-- 16. Cenário funcional completo: usuário da Fiscal A comenta (via
--     RPC) ANTES do encaminhamento -> vira participante; ticket é
--     encaminhado para Suporte TI de B (via UPDATE simulando a
--     futura RPC, current_user='postgres'); esse usuário CONTINUA
--     vendo via perna 3 de 3.3.
-- 17. Outro membro da Fiscal A que NUNCA comentou/agiu PERDE acesso
--     depois do encaminhamento.
-- 18. Participante (cenário 16) tenta UPDATE direto -> rejeitado
--     (policy 3.4 não tem perna de participante nem de destino).
-- 19. Link A->B desativado depois de um encaminhamento já existente
--     -> ticket continua 100% visível (nenhuma policy desta migration
--     consulta internal_ticket_account_links).
-- 20. Usuário de uma terceira conta C não aparece em nenhuma policy
--     nova — SELECT do ticket, comentários e eventos continuam
--     vazios para ele.
--
-- ---- Guard (correção da 2ª revisão externa) ----
-- 21. Como `authenticated` (RLS-scoped, ex.: client Supabase normal):
--     UPDATE internal_tickets SET target_account_id = <account
--     existente> WHERE id = <ticket próprio> -> REJEITADO, SQLSTATE
--     42501 ("can only be changed by a trusted SECURITY DEFINER
--     function"). Confirmar que o erro realmente aparece agora (na
--     1ª versão desta migration, o guard não disparava).
-- 22. Como `service_role` (supabaseAdmin(), UPDATE direto na tabela,
--     SEM passar pela futura RPC): mesmo UPDATE de target_account_id
--     -> também REJEITADO, 42501. Confirma que nem o backend
--     server-side contorna o guard fora da RPC.
-- 23. Executando como `postgres` (ex.: `SET LOCAL ROLE postgres;` numa
--     sessão de teste, ou dentro de uma função SECURITY DEFINER OWNER
--     TO postgres) com tenancy válida (team_id/assigned_user_id já
--     pertencentes à conta de destino, ou NULL): UPDATE de
--     target_account_id -> PERMITIDO pelo guard. Se team_id/
--     assigned_user_id NÃO pertencerem à conta efetiva, o trigger
--     validate_tenancy (2.1) ainda rejeita — comportamento esperado,
--     não é falha do guard.
-- 24. Conceitual (não executável isoladamente antes da 066 existir):
--     confirmar por leitura que forward_internal_ticket, ao ser
--     SECURITY DEFINER OWNER TO postgres, já terá current_user =
--     'postgres' no momento em que ela mesma fizer o UPDATE de
--     target_account_id — logo o guard (agora INVOKER) vai herdar
--     esse current_user e permitir. Reconfirmar isso na prática assim
--     que a 066 for escrita e aplicada.
--
-- ---- Backfill de participants ----
-- 25. Para um ticket criado antes da 065: SELECT 1 FROM
--     internal_ticket_participants WHERE ticket_id = <ticket> AND
--     user_id = <ticket.created_by> -> existe.
-- 26. Para um evento histórico com actor_user_id preenchido: esse
--     (ticket_id, actor_user_id) aparece em participants.
-- 27. Para um comentário histórico: esse (ticket_id, author_id)
--     aparece em participants.
-- 28. Para um ticket com assigned_user_id histórico preenchido: esse
--     (ticket_id, assigned_user_id) aparece em participants — testar
--     pelo menos 1 caso com evento assignee_changed correspondente
--     (timestamp deve bater com o evento) e, se existir no ambiente,
--     1 caso sem evento correspondente (timestamp deve cair no
--     created_at do ticket, via fallback).
-- 29. Para um usuário que, no mesmo ticket, aparece em mais de uma
--     fonte (ex.: criou E comentou depois): first_seen_at gravado é o
--     MENOR timestamp real entre as fontes em que ele aparece (ex.:
--     created_at do ticket, não created_at do comentário posterior).
-- 30. Para um membro de internal_team_members que NUNCA criou,
--     comentou, gerou evento ou foi assigned num ticket específico:
--     NÃO existe linha dele em internal_ticket_participants para esse
--     ticket (a mera membership de equipe não vira participante).
-- 31. Reexecutar a migration inteira (idempotência do backfill):
--     count(*) de internal_ticket_participants antes/depois da 2ª
--     execução é IDÊNTICO, e first_seen_at das linhas já existentes
--     não muda — o INSERT usa ON CONFLICT (ticket_id, user_id) DO
--     NOTHING, nunca UPDATE.
--
-- ---- Correção do vazamento cross-tenant via participante (item 9) ----
-- 32. Usuário U comentou um chamado LOCAL (target NULL) da conta A —
--     vira participante (linha em internal_ticket_participants).
--     Depois, o profile de U é movido inteiramente para a conta C
--     (create_account_member ou equivalente; U deixa de ter QUALQUER
--     profile em A). U tenta SELECT no chamado -> AGORA REJEITADO
--     (0 linhas) mesmo com a linha em participants intacta — a perna
--     3/3 exige is_account_member(A), que passa a ser falso para U.
--     Este é o achado crítico corrigido nesta rodada; confirmar que a
--     versão sem o fix (só EXISTS em participants, sem o
--     is_account_member) retornaria a linha indevidamente antes de
--     aplicar a correção.
-- 33. Mesmo cenário do 32, mas o chamado FOI encaminhado para a conta
--     B antes de U deixar A, e U nunca teve profile em B -> U também
--     não vê (nem account_id nem target_account_id batem com a conta
--     atual de U).
-- 34. Mesmo cenário do 32, mas em vez de trocar de conta, o profile de
--     U em A é apenas desativado (profiles.is_active = false) ou a
--     própria conta A é desativada (accounts.is_active = false) -> U
--     também perde a perna de participante (is_account_member já
--     cobre os dois casos via 048), sem precisar de lógica adicional.
-- ============================================================
