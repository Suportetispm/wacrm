-- ============================================================
-- 054_internal_ticket_operations
--
-- 052-INT-C — as três RPCs operacionais que a fundação (052) deixou
-- deliberadamente para depois: criar chamado, editar chamado, e
-- comentar. Nenhuma tabela nova, nenhuma RLS nova, nenhum trigger
-- novo, nenhuma alteração nas migrations 052/053 — só as 3 funções
-- abaixo, todas SECURITY DEFINER.
--
-- POR QUE UMA RPC E NÃO CHAMADAS DIRETAS DO CLIENT/service_role:
--   - internal_tickets não tem policy de INSERT (de propósito, desde
--     a 052) e allocate_internal_ticket_number está REVOKE ALL até de
--     service_role (só o owner `postgres` pode chamá-la) — criar um
--     chamado é fisicamente impossível sem uma função dona de
--     postgres que faça a ponte;
--   - internal_ticket_events não tem NENHUMA policy de INSERT para
--     `authenticated` — é append-only por trigger/RPC futura, por
--     design (comentário original da 052, seção 1.10/3.5);
--   - "criar ticket + alocar código + logar evento inicial",
--     "editar ticket + logar os eventos de diff" e "criar comentário +
--     logar evento" precisam ser atômicos — duas chamadas
--     independentes do client (INSERT ticket, depois INSERT evento)
--     seriam duas transações, e uma falha entre elas deixaria um
--     estado parcial (ticket sem evento inicial, edição sem
--     rastro no histórico, comentário sem evento) — exatamente a
--     classe de bug já corrigida na 053 para os defaults de
--     status/etapa.
--
-- PADRÃO DE SEGURANÇA (as 3 funções): SECURITY DEFINER, OWNER TO
-- postgres, SET search_path = public, REVOKE ALL FROM PUBLIC, anon,
-- authenticated, GRANT EXECUTE só para service_role — chamadas
-- exclusivamente pelo backend (rota já autenticada via
-- requireRole()), nunca pelo browser. MAS nenhuma delas confia
-- apenas nisso: cada uma revalida internamente que p_actor_user_id
-- existe em profiles, pertence a p_account_id, está is_active=true, a
-- própria account está is_active=true, e que o papel resultante tem
-- permissão para aquela operação específica — mesmo padrão de
-- autochecagem já usado pelas RPCs operacionais de `tickets`
-- (claim_ticket/transfer_ticket_queue/etc., migration 049), adaptado
-- porque aqui o "ator" chega como parâmetro explícito (chamada via
-- service_role, sem sessão/auth.uid() própria), não via auth.uid()
-- como lá.
--
-- Validação de tenancy dos FKs (type_id/status_id/stage_id/team_id/
-- internal_company_id/assigned_user_id/created_by/author_id) NÃO é
-- duplicada aqui — os triggers já existentes da 052
-- (internal_tickets_validate_tenancy, internal_ticket_comments_
-- validate_tenancy) disparam automaticamente em todo INSERT/UPDATE
-- feito por estas RPCs e continuam sendo a única autoridade sobre
-- isso. O que as RPCs abaixo adicionam é exclusivamente: (a) a ponte
-- para o allocator travado, (b) a reprodução da regra real de
-- autorização por envolvimento (RLS) para quando o caller roda como
-- service_role e portanto bypassa RLS, e (c) a atomicidade
-- ticket+evento(s).
--
-- ERRCODE usados, por convenção (mesmas já usadas no módulo):
--   P0002  -- não encontrado / de outra account (mesma mensagem para
--             os dois casos, nunca um oráculo de existência)
--   42501  -- autorização: papel insuficiente, ou não envolvido
--   22023  -- validação de entrada: parâmetro ausente/vazio/inválido
-- ============================================================

-- ============================================================
-- 1. create_internal_ticket
--
-- Abre um chamado novo. Só agent/admin/owner (viewer nunca cria —
-- checado aqui dentro, não só via requireRole da rota futura).
-- status_id/stage_id ausentes (NULL) resolvem para o default ATUAL
-- da account, lido do catálogo (nunca hardcoded por nome). status
-- default é exigido (coluna NOT NULL do schema) — se a account não
-- tiver nenhum status is_default=true, a criação falha explicitamente
-- em vez de inserir um status_id inválido. stage é opcional por
-- schema (coluna NULL-able): se não houver etapa default configurada,
-- o chamado nasce sem etapa (stage_id NULL) em vez de bloquear a
-- criação — assimetria deliberada, espelhando a própria assimetria
-- NOT NULL vs NULL das duas colunas em internal_tickets.
--
-- internal_code: exclusivamente via allocate_internal_ticket_number
-- (nunca MAX()+1, nunca gerado no client). Como esta função é dona de
-- `postgres` (mesmo owner de allocate_internal_ticket_number), pode
-- chamá-la mesmo com o REVOKE ALL da 052 — REVOKE só restringe OUTRAS
-- roles, nunca o dono de uma função sobre suas próprias chamadas.
--
-- Tudo — alocação do código, INSERT do ticket, INSERT do evento
-- 'created' — roda dentro da mesma transação implícita da função:
-- qualquer RAISE EXCEPTION em qualquer ponto desfaz TUDO, inclusive a
-- alocação do número (o contador em si nunca "vaza" um número não
-- usado de forma observável: se a transação inteira for revertida, o
-- UPDATE do contador também é revertido).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_internal_ticket(
  p_account_id UUID,
  p_actor_user_id UUID,
  p_title TEXT,
  p_description TEXT,
  p_type_id UUID,
  p_status_id UUID DEFAULT NULL,
  p_stage_id UUID DEFAULT NULL,
  p_team_id UUID DEFAULT NULL,
  p_internal_company_id UUID DEFAULT NULL,
  p_assigned_user_id UUID DEFAULT NULL
) RETURNS internal_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role   account_role_enum;
  v_actor_active BOOLEAN;
  v_account_active BOOLEAN;
  v_title      TEXT;
  v_status_id  UUID;
  v_stage_id   UUID;
  v_code       BIGINT;
  v_ticket     internal_tickets;
  v_type_active    BOOLEAN;
  v_status_active  BOOLEAN;
  v_stage_active   BOOLEAN;
  v_team_active    BOOLEAN;
  v_company_active BOOLEAN;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_type_id IS NULL THEN
    RAISE EXCEPTION 'type_id is required' USING ERRCODE = '22023';
  END IF;

  v_title := NULLIF(btrim(COALESCE(p_title, '')), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'title is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_title) > 120 THEN
    RAISE EXCEPTION 'title must be 120 characters or fewer' USING ERRCODE = '22023';
  END IF;

  -- Autorização: revalidada aqui dentro, nunca herdada só da rota.
  -- Mesma checagem de is_account_member (profiles+accounts, ambos
  -- is_active), mas contra p_actor_user_id — auth.uid() não existe
  -- neste contexto (chamada via service_role, sem sessão própria).
  SELECT p.account_role, p.is_active, a.is_active
    INTO v_actor_role, v_actor_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = p_actor_user_id AND p.account_id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_actor_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_actor_role NOT IN ('agent', 'admin', 'owner') THEN
    RAISE EXCEPTION 'Caller role cannot create internal tickets' USING ERRCODE = '42501';
  END IF;

  -- HARDENING (revisão pós-implementação da UI): internal_tickets_
  -- validate_tenancy (052) valida SÓ tenancy dos catálogos (mesma
  -- account), nunca is_active — por design daquele trigger, para não
  -- impedir que um chamado JÁ ABERTO continue referenciando um item
  -- de catálogo desativado depois (ver comentário da própria 052,
  -- seção 2.3). Isso significa que, sem uma checagem própria aqui,
  -- CRIAR um chamado NOVO apontando diretamente para um type_id/
  -- status_id/stage_id/team_id/internal_company_id INATIVO (mas da
  -- conta certa) passava sem erro nenhum — a UI só oferece itens
  -- ativos, mas nada no banco impedia chamar a API diretamente com um
  -- id inativo. Cada checagem abaixo só dispara quando a linha É
  -- encontrada NA MESMA account e está inativa — "não encontrado" ou
  -- "de outra account" continuam sem erro aqui, tratados do jeito de
  -- sempre pelo trigger/FK na hora do INSERT (nunca um oráculo novo
  -- de existência).
  SELECT is_active INTO v_type_active
  FROM internal_ticket_types WHERE id = p_type_id AND account_id = p_account_id;
  IF v_type_active IS NOT NULL AND NOT v_type_active THEN
    RAISE EXCEPTION 'type_id must reference an active type' USING ERRCODE = '22023';
  END IF;

  -- Status default: obrigatório (coluna NOT NULL) — sem fallback
  -- silencioso se a account não tiver nenhum default configurado.
  -- Quando resolvido do default (não informado), já vem ativo por
  -- construção (CHECK NOT is_default OR is_active, 052) — a checagem
  -- abaixo roda do mesmo jeito, sem custo real, para os dois casos.
  IF p_status_id IS NOT NULL THEN
    v_status_id := p_status_id;
  ELSE
    SELECT id INTO v_status_id
    FROM internal_ticket_statuses
    WHERE account_id = p_account_id AND is_default;
    IF v_status_id IS NULL THEN
      RAISE EXCEPTION 'No default internal ticket status configured for this account' USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT is_active INTO v_status_active
  FROM internal_ticket_statuses WHERE id = v_status_id AND account_id = p_account_id;
  IF v_status_active IS NOT NULL AND NOT v_status_active THEN
    RAISE EXCEPTION 'status_id must reference an active status' USING ERRCODE = '22023';
  END IF;

  -- Etapa default: melhor esforço (coluna NULL-able) — ausência de
  -- default configurado não bloqueia a criação, o chamado só nasce
  -- sem etapa.
  IF p_stage_id IS NOT NULL THEN
    v_stage_id := p_stage_id;
  ELSE
    SELECT id INTO v_stage_id
    FROM internal_ticket_stages
    WHERE account_id = p_account_id AND is_default;
  END IF;
  IF v_stage_id IS NOT NULL THEN
    SELECT is_active INTO v_stage_active
    FROM internal_ticket_stages WHERE id = v_stage_id AND account_id = p_account_id;
    IF v_stage_active IS NOT NULL AND NOT v_stage_active THEN
      RAISE EXCEPTION 'stage_id must reference an active stage' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_team_id IS NOT NULL THEN
    SELECT is_active INTO v_team_active
    FROM internal_teams WHERE id = p_team_id AND account_id = p_account_id;
    IF v_team_active IS NOT NULL AND NOT v_team_active THEN
      RAISE EXCEPTION 'team_id must reference an active team' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_internal_company_id IS NOT NULL THEN
    SELECT is_active INTO v_company_active
    FROM internal_companies WHERE id = p_internal_company_id AND account_id = p_account_id;
    IF v_company_active IS NOT NULL AND NOT v_company_active THEN
      RAISE EXCEPTION 'internal_company_id must reference an active company' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Único ponto de alocação do código — nunca MAX()+1, nunca no
  -- client. Atômico por construção (052, INSERT...ON CONFLICT DO
  -- UPDATE...RETURNING). Alocado só DEPOIS de todas as checagens
  -- acima passarem — uma criação rejeitada nunca "gasta" um número.
  v_code := public.allocate_internal_ticket_number(p_account_id);

  -- internal_tickets_validate_tenancy (052) dispara aqui e valida
  -- type_id/status_id/stage_id/team_id/internal_company_id/
  -- assigned_user_id/created_by — não duplicado nesta função.
  INSERT INTO internal_tickets (
    account_id, internal_code, title, description,
    type_id, status_id, stage_id, team_id, internal_company_id,
    assigned_user_id, created_by
  ) VALUES (
    p_account_id, v_code, v_title, NULLIF(btrim(COALESCE(p_description, '')), ''),
    p_type_id, v_status_id, v_stage_id, p_team_id, p_internal_company_id,
    p_assigned_user_id, p_actor_user_id
  )
  RETURNING * INTO v_ticket;

  INSERT INTO internal_ticket_events (
    account_id, ticket_id, event_type, actor_user_id, to_value, payload
  ) VALUES (
    p_account_id, v_ticket.id, 'created', p_actor_user_id, v_ticket.internal_code::text,
    jsonb_build_object(
      'type_id', v_ticket.type_id,
      'status_id', v_ticket.status_id,
      'stage_id', v_ticket.stage_id,
      'team_id', v_ticket.team_id,
      'internal_company_id', v_ticket.internal_company_id,
      'assigned_user_id', v_ticket.assigned_user_id
    )
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.create_internal_ticket(UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_internal_ticket(UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_internal_ticket(UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID) TO service_role;

-- ============================================================
-- 2. update_internal_ticket
--
-- Edita campos permitidos de um chamado existente e loga um evento
-- por campo que REALMENTE mudou, tudo em uma transação.
--
-- p_changes é um objeto JSONB — só as 8 chaves abaixo são aceitas;
-- qualquer chave fora dessa lista é REJEITADA (erro), nunca
-- silenciosamente ignorada. id/account_id/internal_code/created_by/
-- created_at/updated_at/scheduled_at/completed_at/cancelled_at/
-- cancel_reason nunca entram nessa lista — os cinco primeiros são
-- estruturalmente imutáveis (trigger da 052), os quatro últimos estão
-- fora do escopo funcional desta fase (052-INT-C não implementa
-- agendamento/conclusão/cancelamento).
--
-- Presença de chave (`p_changes ? 'campo'`), não o valor, decide se um
-- campo é alterado — permite diferenciar "não enviado" (mantém valor
-- atual) de "enviado como null" (limpa o campo), respeitando a
-- nulabilidade real de cada coluna: stage_id/team_id/
-- internal_company_id/assigned_user_id aceitam null (limpar
-- etapa/equipe/empresa/responsável); title/type_id/status_id são
-- NOT NULL no schema e um valor null explícito é rejeitado com erro
-- de validação, nunca vira um UPDATE que violaria a constraint.
--
-- AUTORIZAÇÃO — reproduz a policy REAL de UPDATE da 052 (não uma
-- aproximação), porque SECURITY DEFINER bypassa RLS por completo:
--   USING e WITH CHECK da policy `internal_tickets_update` são
--   TEXTUALMENTE idênticos, mas resolvem contra linhas diferentes —
--   USING contra a linha ANTIGA (decide se a linha é sequer elegível
--   para UPDATE), WITH CHECK contra a linha NOVA, já com as colunas
--   do SET aplicadas (decide se o resultado ainda é permitido). Para
--   admin/owner (is_account_member(account_id,'admin')) isso nunca
--   importa — bypassam as duas metades sempre. Para agent, as DUAS
--   metades precisam passar:
--     - envolvimento na linha ANTIGA (created_by/assigned_user_id/
--       membro ativo do team_id ANTIGO) — se falhar, a linha nunca
--       seria nem "vista" pelo UPDATE (USING);
--     - envolvimento na linha NOVA (created_by não muda nunca;
--       assigned_user_id/team_id já com os valores pós-p_changes) —
--       se falhar, o UPDATE inteiro seria revertido pelo WITH CHECK.
--   Esta função replica exatamente essa dupla checagem abaixo (v_was_
--   involved / v_will_be_involved) para actor não-admin.
--
--   CASO CRÍTICO AUDITADO (pedido explicitamente): agent membro ativo
--   APENAS da equipe ATUAL do chamado (não é created_by nem
--   assigned_user_id) tenta mover o chamado para uma equipe da qual
--   NÃO é membro, no mesmo UPDATE que lhe dava acesso. CONCLUSÃO,
--   verificada lendo o SQL real da policy (052, seção 3.3): USING
--   passa (a linha ANTIGA, com o team_id antigo, ainda o inclui como
--   membro) — mas WITH CHECK FALHA, porque `internal_team_members tm
--   WHERE tm.team_id = internal_tickets.team_id` dentro do WITH CHECK
--   lê o team_id NOVO (o de destino), do qual o agent não é membro, e
--   nenhuma das outras duas condições (created_by/assigned_user_id)
--   se aplica a ele neste cenário. RLS real BLOQUEIA essa mudança — a
--   checagem v_will_be_involved abaixo reproduz exatamente esse
--   bloqueio (RAISE 42501), não permite silenciosamente.
--
--   Consequência adicional, também verificada e reproduzida aqui: um
--   agent SEM NENHUM envolvimento na linha ANTIGA (nem criador, nem
--   responsável, nem membro da equipe atual) não consegue sequer
--   iniciar um UPDATE — nem para se autoatribuir. A checagem
--   v_was_involved abaixo cobre exatamente isso.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_internal_ticket(
  p_account_id UUID,
  p_actor_user_id UUID,
  p_ticket_id UUID,
  p_changes JSONB
) RETURNS internal_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role      account_role_enum;
  v_actor_active    BOOLEAN;
  v_account_active  BOOLEAN;
  v_is_admin        BOOLEAN;
  v_old             internal_tickets;
  v_new             internal_tickets;
  v_key             TEXT;
  v_was_involved    BOOLEAN;
  v_will_be_involved BOOLEAN;
  v_new_title       TEXT;
  v_new_description TEXT;
  v_new_type_id     UUID;
  v_new_status_id   UUID;
  v_new_stage_id    UUID;
  v_new_team_id     UUID;
  v_new_company_id  UUID;
  v_new_assignee_id UUID;
  v_type_active     BOOLEAN;
  v_status_active   BOOLEAN;
  v_stage_active    BOOLEAN;
  v_team_active     BOOLEAN;
  v_company_active  BOOLEAN;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'changes must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Allowlist estrita — qualquer chave fora dela é REJEITADA, nunca
  -- ignorada silenciosamente.
  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN (
      'title', 'description', 'type_id', 'status_id', 'stage_id',
      'team_id', 'internal_company_id', 'assigned_user_id'
    ) THEN
      RAISE EXCEPTION 'Unknown field in changes: %', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM jsonb_object_keys(p_changes)) = 0 THEN
    RAISE EXCEPTION 'No recognized fields to update' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_role, p.is_active, a.is_active
    INTO v_actor_role, v_actor_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = p_actor_user_id AND p.account_id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_actor_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_actor_role NOT IN ('agent', 'admin', 'owner') THEN
    RAISE EXCEPTION 'Caller role cannot update internal tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_actor_role IN ('admin', 'owner');

  -- id + account_id juntos, sempre — "não encontrado" e "existe em
  -- outra account" nunca são distinguíveis pelo erro (mesma mensagem/
  -- código dos triggers/RPCs já existentes no módulo).
  SELECT * INTO v_old
  FROM internal_tickets
  WHERE id = p_ticket_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Internal ticket not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_is_admin THEN
    v_was_involved := (
      v_old.created_by = p_actor_user_id
      OR v_old.assigned_user_id = p_actor_user_id
      OR (
        v_old.team_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = v_old.team_id
            AND tm.account_id = p_account_id
            AND tm.user_id = p_actor_user_id
            AND tm.is_active
        )
      )
    );
    IF NOT v_was_involved THEN
      RAISE EXCEPTION 'Caller is not involved with this internal ticket' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Resolve os 8 valores NOVOS — presença de chave decide se o campo
  -- muda; ausência mantém o valor atual.
  v_new_title := CASE WHEN p_changes ? 'title' THEN NULLIF(btrim(p_changes->>'title'), '') ELSE v_old.title END;
  IF v_new_title IS NULL THEN
    RAISE EXCEPTION 'title cannot be empty' USING ERRCODE = '22023';
  END IF;
  IF length(v_new_title) > 120 THEN
    RAISE EXCEPTION 'title must be 120 characters or fewer' USING ERRCODE = '22023';
  END IF;

  v_new_description := CASE WHEN p_changes ? 'description' THEN NULLIF(btrim(p_changes->>'description'), '') ELSE v_old.description END;

  v_new_type_id := CASE WHEN p_changes ? 'type_id' THEN (p_changes->>'type_id')::UUID ELSE v_old.type_id END;
  IF v_new_type_id IS NULL THEN
    RAISE EXCEPTION 'type_id cannot be null' USING ERRCODE = '22023';
  END IF;
  -- HARDENING (revisão pós-implementação da UI): só valida is_active
  -- quando o valor REALMENTE muda — um chamado com um type_id já
  -- inativo continua podendo ser salvo sem tocar esse campo (ex.:
  -- PATCH só de title), e reenviar o MESMO type_id inativo (no-op) é
  -- inofensivo e cai fora deste IF. Só uma mudança de fato para um
  -- type_id DIFERENTE exige que o alvo esteja ativo.
  IF v_new_type_id IS DISTINCT FROM v_old.type_id THEN
    SELECT is_active INTO v_type_active
    FROM internal_ticket_types WHERE id = v_new_type_id AND account_id = p_account_id;
    IF v_type_active IS NOT NULL AND NOT v_type_active THEN
      RAISE EXCEPTION 'type_id must reference an active type' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_status_id := CASE WHEN p_changes ? 'status_id' THEN (p_changes->>'status_id')::UUID ELSE v_old.status_id END;
  IF v_new_status_id IS NULL THEN
    RAISE EXCEPTION 'status_id cannot be null' USING ERRCODE = '22023';
  END IF;
  IF v_new_status_id IS DISTINCT FROM v_old.status_id THEN
    SELECT is_active INTO v_status_active
    FROM internal_ticket_statuses WHERE id = v_new_status_id AND account_id = p_account_id;
    IF v_status_active IS NOT NULL AND NOT v_status_active THEN
      RAISE EXCEPTION 'status_id must reference an active status' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_stage_id    := CASE WHEN p_changes ? 'stage_id' THEN (p_changes->>'stage_id')::UUID ELSE v_old.stage_id END;
  IF v_new_stage_id IS DISTINCT FROM v_old.stage_id AND v_new_stage_id IS NOT NULL THEN
    SELECT is_active INTO v_stage_active
    FROM internal_ticket_stages WHERE id = v_new_stage_id AND account_id = p_account_id;
    IF v_stage_active IS NOT NULL AND NOT v_stage_active THEN
      RAISE EXCEPTION 'stage_id must reference an active stage' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_team_id     := CASE WHEN p_changes ? 'team_id' THEN (p_changes->>'team_id')::UUID ELSE v_old.team_id END;
  IF v_new_team_id IS DISTINCT FROM v_old.team_id AND v_new_team_id IS NOT NULL THEN
    SELECT is_active INTO v_team_active
    FROM internal_teams WHERE id = v_new_team_id AND account_id = p_account_id;
    IF v_team_active IS NOT NULL AND NOT v_team_active THEN
      RAISE EXCEPTION 'team_id must reference an active team' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_company_id  := CASE WHEN p_changes ? 'internal_company_id' THEN (p_changes->>'internal_company_id')::UUID ELSE v_old.internal_company_id END;
  IF v_new_company_id IS DISTINCT FROM v_old.internal_company_id AND v_new_company_id IS NOT NULL THEN
    SELECT is_active INTO v_company_active
    FROM internal_companies WHERE id = v_new_company_id AND account_id = p_account_id;
    IF v_company_active IS NOT NULL AND NOT v_company_active THEN
      RAISE EXCEPTION 'internal_company_id must reference an active company' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_assignee_id := CASE WHEN p_changes ? 'assigned_user_id' THEN (p_changes->>'assigned_user_id')::UUID ELSE v_old.assigned_user_id END;

  -- Reprodução do WITH CHECK real (ver cabeçalho): a linha NOVA
  -- também precisa manter o agent envolvido, avaliada contra os
  -- valores NOVOS de assigned_user_id/team_id (created_by nunca muda).
  IF NOT v_is_admin THEN
    v_will_be_involved := (
      v_old.created_by = p_actor_user_id
      OR v_new_assignee_id = p_actor_user_id
      OR (
        v_new_team_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = v_new_team_id
            AND tm.account_id = p_account_id
            AND tm.user_id = p_actor_user_id
            AND tm.is_active
        )
      )
    );
    IF NOT v_will_be_involved THEN
      RAISE EXCEPTION 'This change would remove the caller''s access to the internal ticket' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- HARDENING (revisão pós-aprovação): antes desta revisão o UPDATE
  -- abaixo rodava incondicionalmente, mesmo quando os 8 valores
  -- resolvidos são idênticos aos atuais (ex.: p_changes = {"status_id":
  -- "<mesmo-id-que-já-tinha>"}) — bumpava updated_at (fazendo o
  -- chamado parecer alterado sem nenhuma mudança real) e disparava o
  -- trigger de tenancy à toa, mas nenhum evento era gravado (IS
  -- DISTINCT FROM não via diferença nenhuma) — um UPDATE observável
  -- sem nenhum evento correspondente. Corrigido: se NENHUM dos 8
  -- campos difere do valor atual, pula o UPDATE inteiro (nenhum
  -- updated_at novo, nenhum disparo de trigger, nenhum evento) e
  -- retorna a linha atual diretamente. A autorização (actor válido,
  -- papel, was_involved/will_be_involved acima) já foi checada por
  -- completo ANTES deste ponto — este early return nunca vira uma
  -- forma de consultar o ticket sem autorização, é um no-op já
  -- validado.
  IF v_old.title IS NOT DISTINCT FROM v_new_title
     AND v_old.description IS NOT DISTINCT FROM v_new_description
     AND v_old.type_id IS NOT DISTINCT FROM v_new_type_id
     AND v_old.status_id IS NOT DISTINCT FROM v_new_status_id
     AND v_old.stage_id IS NOT DISTINCT FROM v_new_stage_id
     AND v_old.team_id IS NOT DISTINCT FROM v_new_team_id
     AND v_old.internal_company_id IS NOT DISTINCT FROM v_new_company_id
     AND v_old.assigned_user_id IS NOT DISTINCT FROM v_new_assignee_id
  THEN
    RETURN v_old;
  END IF;

  -- UM UPDATE só, sempre tocando as 8 colunas (mesmo as inalteradas)
  -- — garante que o trigger validate_tenancy (BEFORE UPDATE OF
  -- type_id, status_id, stage_id, team_id, internal_company_id,
  -- assigned_user_id) sempre dispare e revalide tenancy, sem SQL
  -- dinâmico. Só chega aqui quando pelo menos um dos 8 campos
  -- realmente muda (ver checagem de no-op acima).
  UPDATE internal_tickets SET
    title = v_new_title,
    description = v_new_description,
    type_id = v_new_type_id,
    status_id = v_new_status_id,
    stage_id = v_new_stage_id,
    team_id = v_new_team_id,
    internal_company_id = v_new_company_id,
    assigned_user_id = v_new_assignee_id
  WHERE id = p_ticket_id
  RETURNING * INTO v_new;

  -- Um evento por campo que REALMENTE mudou — nunca um "updated"
  -- genérico (não existe no CHECK de event_type). from_value/to_value
  -- de campos de referência (*_id) guardam o UUID cru, como o resto
  -- do projeto já faz (ex.: transferred_queue/transferred_agent na
  -- 049) — a UI resolve o nome de exibição a partir do catálogo, a
  -- RPC não faz join extra para isso.
  IF v_old.title IS DISTINCT FROM v_new.title THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'title_changed', p_actor_user_id, v_old.title, v_new.title);
  END IF;

  -- description: DELIBERADAMENTE não guarda o texto integral
  -- antigo/novo no evento — descrições podem ser longas, e duplicar o
  -- texto inteiro a cada edição no histórico não tem valor de UX
  -- proporcional ao custo de armazenamento/exposição. O evento só
  -- registra QUE mudou; o valor atual já está disponível lendo
  -- internal_tickets.description diretamente.
  IF v_old.description IS DISTINCT FROM v_new.description THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, payload)
    VALUES (p_account_id, p_ticket_id, 'description_changed', p_actor_user_id, '{}'::jsonb);
  END IF;

  IF v_old.type_id IS DISTINCT FROM v_new.type_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'type_changed', p_actor_user_id, v_old.type_id::text, v_new.type_id::text);
  END IF;

  IF v_old.status_id IS DISTINCT FROM v_new.status_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'status_changed', p_actor_user_id, v_old.status_id::text, v_new.status_id::text);
  END IF;

  IF v_old.stage_id IS DISTINCT FROM v_new.stage_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'stage_changed', p_actor_user_id, v_old.stage_id::text, v_new.stage_id::text);
  END IF;

  IF v_old.team_id IS DISTINCT FROM v_new.team_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'team_changed', p_actor_user_id, v_old.team_id::text, v_new.team_id::text);
  END IF;

  IF v_old.internal_company_id IS DISTINCT FROM v_new.internal_company_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'company_changed', p_actor_user_id, v_old.internal_company_id::text, v_new.internal_company_id::text);
  END IF;

  IF v_old.assigned_user_id IS DISTINCT FROM v_new.assigned_user_id THEN
    INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value)
    VALUES (p_account_id, p_ticket_id, 'assignee_changed', p_actor_user_id, v_old.assigned_user_id::text, v_new.assigned_user_id::text);
  END IF;

  RETURN v_new;
END;
$$;

ALTER FUNCTION public.update_internal_ticket(UUID, UUID, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_internal_ticket(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_internal_ticket(UUID, UUID, UUID, JSONB) TO service_role;

-- ============================================================
-- 3. add_internal_ticket_comment
--
-- Cria um comentário e loga 'comment_added' na mesma transação. Só
-- agent/admin/owner (viewer nunca comenta); agent precisa do mesmo
-- envolvimento exigido pela RLS real de INSERT em
-- internal_ticket_comments (052, seção 3.4: author_id=auth.uid() E
-- agent+ E (admin OU created_by OU assigned_user_id OU membro ativo
-- da equipe atual do ticket)) — reproduzido abaixo com p_actor_user_id
-- no lugar de auth.uid(), pelo mesmo motivo das outras duas funções.
--
-- Edição/soft-delete de comentário ficam FORA desta migration (fora
-- do escopo funcional decidido para 052-INT-C) — a infraestrutura de
-- soft-delete (deleted_at/deleted_by) já existe na 052 e a RLS de
-- UPDATE de internal_ticket_comments já permite autor-ou-admin
-- editar/soft-deletar diretamente via RLS (ctx.supabase), sem
-- precisar de RPC nenhuma quando essa fase futura chegar.
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_internal_ticket_comment(
  p_account_id UUID,
  p_actor_user_id UUID,
  p_ticket_id UUID,
  p_body TEXT
) RETURNS internal_ticket_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role     account_role_enum;
  v_actor_active   BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin       BOOLEAN;
  v_ticket         internal_tickets;
  v_body           TEXT;
  v_involved       BOOLEAN;
  v_comment        internal_ticket_comments;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;

  v_body := NULLIF(btrim(COALESCE(p_body, '')), '');
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Comment body cannot be empty' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_role, p.is_active, a.is_active
    INTO v_actor_role, v_actor_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = p_actor_user_id AND p.account_id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_actor_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_actor_role NOT IN ('agent', 'admin', 'owner') THEN
    RAISE EXCEPTION 'Caller role cannot comment on internal tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_actor_role IN ('admin', 'owner');

  -- Lock defensivo: evita uma corrida onde o team_id do ticket muda
  -- concorrentemente entre a checagem de envolvimento e o INSERT.
  SELECT * INTO v_ticket
  FROM internal_tickets
  WHERE id = p_ticket_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Internal ticket not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_is_admin THEN
    v_involved := (
      v_ticket.created_by = p_actor_user_id
      OR v_ticket.assigned_user_id = p_actor_user_id
      OR (
        v_ticket.team_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = v_ticket.team_id
            AND tm.account_id = p_account_id
            AND tm.user_id = p_actor_user_id
            AND tm.is_active
        )
      )
    );
    IF NOT v_involved THEN
      RAISE EXCEPTION 'Caller is not involved with this internal ticket' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO internal_ticket_comments (account_id, ticket_id, author_id, body)
  VALUES (p_account_id, p_ticket_id, p_actor_user_id, v_body)
  RETURNING * INTO v_comment;

  -- payload guarda só o id do comentário, nunca o corpo do texto —
  -- mesmo raciocínio de não duplicar texto livre potencialmente longo
  -- no histórico (ver description_changed acima). O comentário em si
  -- já é a fonte de verdade do seu próprio conteúdo.
  INSERT INTO internal_ticket_events (account_id, ticket_id, event_type, actor_user_id, payload)
  VALUES (p_account_id, p_ticket_id, 'comment_added', p_actor_user_id, jsonb_build_object('comment_id', v_comment.id));

  RETURN v_comment;
END;
$$;

ALTER FUNCTION public.add_internal_ticket_comment(UUID, UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_internal_ticket_comment(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_internal_ticket_comment(UUID, UUID, UUID, TEXT) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049-053).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
-- Nenhum passo abaixo é executado por esta migration.
--
-- ---- Estrutural ----
--
--  1. As 3 funções existem:
--       SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--         AND proname IN ('create_internal_ticket', 'update_internal_ticket', 'add_internal_ticket_comment');
--     Esperado: 3 linhas.
--
--  2. SECURITY DEFINER, owner, search_path corretos:
--       SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig
--       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--       WHERE p.pronamespace = 'public'::regnamespace
--         AND p.proname IN ('create_internal_ticket', 'update_internal_ticket', 'add_internal_ticket_comment');
--     Esperado, para as 3: owner = postgres, prosecdef = true,
--     proconfig contendo 'search_path=public'.
--
--  3. Grants — só service_role (além do owner postgres, que sempre
--     aparece e é esperado):
--       SELECT p.proname, a.grantee, a.privilege_type
--       FROM information_schema.routine_privileges a
--       JOIN pg_proc p ON p.proname = a.routine_name
--       WHERE a.routine_schema = 'public'
--         AND p.proname IN ('create_internal_ticket', 'update_internal_ticket', 'add_internal_ticket_comment')
--         AND a.grantee IN ('PUBLIC', 'anon', 'authenticated');
--     Esperado: zero linhas. Repetir filtrando grantee = 'service_role'
--     -> 3 linhas (uma por função), privilege_type = 'EXECUTE'.
--
--  4. allocate_internal_ticket_number continua fechada — esta
--     migration não altera seus grants:
--       SELECT a.grantee, a.privilege_type
--       FROM information_schema.routine_privileges a
--       WHERE a.routine_schema = 'public' AND a.routine_name = 'allocate_internal_ticket_number';
--     Esperado: nenhuma linha com grantee IN ('PUBLIC','anon','authenticated','service_role')
--     (só postgres, se aparecer).
--
--  5. Zero RLS/tabela/trigger novos introduzidos por esta migration
--     (conferência negativa — nenhum CREATE POLICY, CREATE TABLE ou
--     CREATE TRIGGER aparece no arquivo; grep no próprio .sql):
--       grep -E "CREATE (TABLE|POLICY|TRIGGER)" 054_internal_ticket_operations.sql
--     Esperado: nenhuma linha.
--
--  6. Migrations 052/053 inalteradas (diff contra o que já está em
--     produção) — confirmar fora do banco, via `git diff` nos dois
--     arquivos antes do commit desta migration.
--
-- ---- Comportamental (dependente de dados/sessão) ----
--
--  7. create_internal_ticket:
--       - actor viewer -> 42501.
--       - actor inativo ou de outra account -> 42501.
--       - title vazio/só espaço -> 22023.
--       - p_status_id/p_stage_id omitidos -> ticket criado com o
--         status/etapa is_default=true ATUAIS da account (conferir
--         lendo os catálogos antes de chamar).
--       - account sem nenhum status is_default=true (cenário
--         artificial, forçar em staging) -> 22023, nenhum ticket
--         criado, contador de internal_code NÃO avança (conferir
--         SELECT next_number FROM internal_ticket_counters antes/
--         depois — precisa ser o MESMO valor, confirmando que o
--         ROLLBACK da transação desfez também a alocação).
--       - type_id de outra account -> erro do trigger de tenancy
--         (P0001, mensagem "must reference a type in the same
--         account"), nenhum ticket nem evento criado.
--       - duas chamadas concorrentes na MESMA account -> dois
--         internal_code distintos, sequenciais, sem gap além do
--         esperado.
--       - sucesso -> SELECT count(*) FROM internal_ticket_events
--         WHERE ticket_id = '<novo>' AND event_type = 'created' -> 1.
--       - HARDENING (revisão pós-implementação da UI): p_type_id de um
--         internal_ticket_types com is_active=false (mesma account) ->
--         22023 ("type_id must reference an active type"), nenhum
--         ticket/evento criado, internal_code NÃO avança. Repetir para
--         p_status_id/p_stage_id/p_team_id/p_internal_company_id
--         explicitamente informados apontando para uma linha inativa
--         (mesma account) -> mesma rejeição (22023), cada um com a
--         mensagem específica do próprio campo.
--       - p_status_id/p_stage_id OMITIDOS continuam resolvendo para o
--         default da account normalmente (o default é sempre ativo
--         por construção, CHECK da 052) -> sucesso, sem falso positivo
--         da checagem nova.
--
--  8. update_internal_ticket:
--       - p_changes = NULL -> 22023 ("changes must be a JSON object").
--       - p_changes = '[]'::jsonb (array) -> 22023 (mesmo erro, tipo
--         errado).
--       - p_changes = '"texto"'::jsonb (string) -> 22023.
--       - p_changes = '123'::jsonb (number) -> 22023.
--       - p_changes = '{}'::jsonb (objeto vazio) -> 22023 ("No
--         recognized fields to update").
--       - chave desconhecida em p_changes (ex.: {"account_id": "..."})
--         -> 22023, nenhuma coluna alterada.
--       - title enviado como null/vazio -> 22023.
--       - title com espaços nas duas pontas (ex.: "  Novo título  ")
--         -> salvo já trimado ("Novo título"), mesma normalização do
--         create_internal_ticket.
--       - NO-OP: p_changes contém só campos cujo valor final (após
--         resolver ->>'campo') é IDÊNTICO ao atual (ex.: {"status_id":
--         "<mesmo-id-que-já-tinha>"}) -> RPC retorna a linha atual
--         normalmente, MAS: nenhum UPDATE é executado (confirmar
--         updated_at ANTES e DEPOIS da chamada — precisa ser o MESMO
--         timestamp, ao contrário do que acontecia antes desta
--         revisão), zero linhas novas em internal_ticket_events para
--         este ticket. Repetir como agent envolvido (não só admin) —
--         mesmo resultado.
--       - NO-OP + autorização: repetir o cenário acima com um agent
--         SEM envolvimento no ticket -> continua 42501 (a checagem de
--         no-op só é alcançada DEPOIS de was_involved/will_be_involved
--         passarem; um no-op nunca vira uma forma de ler/confirmar um
--         ticket sem autorização).
--       - admin edita ticket sem nenhum envolvimento -> sucesso.
--       - agent SEM envolvimento na linha ATUAL tenta qualquer edição,
--         inclusive {"assigned_user_id": "<próprio-id>"} -> 42501
--         (bloqueado pela checagem "was_involved", equivalente ao
--         USING falhando antes de qualquer WITH CHECK).
--       - CASO CRÍTICO: agent envolvido SÓ por ser membro ativo da
--         equipe ATUAL, chamando com {"team_id": "<outra-equipe-da-
--         qual-não-é-membro>"} -> 42501 ("would remove the caller's
--         access"), ticket permanece com o team_id original,
--         NENHUM evento gravado. Repetir com uma equipe da qual ELE
--         É membro -> sucesso, evento team_changed gravado.
--       - HARDENING (revisão pós-implementação da UI) — valor
--         histórico inativo preservado: ticket com team_id=X, X é
--         desativada depois (is_active=false). PATCH só de {"title":
--         "..."} (sem tocar team_id) -> sucesso, team_id continua X,
--         nenhuma checagem de is_active é sequer avaliada para
--         team_id (não mudou). PATCH {"team_id": "<X mesmo, o
--         inativo>"} -> sucesso, no-op (cai no caminho de no-op da
--         seção anterior, IS DISTINCT FROM é false — X inativo pode
--         continuar sendo reenviado indefinidamente sem erro). PATCH
--         {"team_id": "<Y, outra equipe TAMBÉM inativa>"} -> 22023
--         ("team_id must reference an active team") — mudar PARA um
--         valor inativo diferente é sempre rejeitado, mesmo que o
--         valor ANTIGO também fosse inativo. PATCH {"team_id": null}
--         -> sucesso, campo limpo (limpar continua permitido
--         independentemente do estado de X). Repetir os 4 casos acima
--         para type_id/status_id (sempre com um valor NOT NULL
--         alternativo, nunca null) e para stage_id/internal_company_id
--         (aceitam null como team_id).
--       - agent envolvido só por team_id, mudando SIMULTANEAMENTE
--         {"team_id": "<outra>", "assigned_user_id": "<próprio-id>"}
--         -> sucesso (fica envolvido pela nova condição
--         assigned_user_id, mesmo saindo da equipe antiga) —
--         confirma que a checagem é "qualquer uma das 3 condições",
--         não uma combinação fixa.
--       - status_id/type_id enviados como null -> 22023, nenhuma
--         coluna alterada.
--       - stage_id/team_id/internal_company_id/assigned_user_id
--         enviados como null -> sucesso, coluna limpa (NULL),
--         respectivo evento *_changed com to_value NULL.
--       - mudar 3 campos de uma vez (ex.: title + status_id + team_id,
--         este último para uma equipe válida) -> exatamente 3 eventos
--         novos, cada um com o event_type certo, na mesma transação.
--       - mudar um campo para o MESMO valor que já tinha -> nenhum
--         evento gravado (IS DISTINCT FROM é false).
--       - type_id/status_id/stage_id/team_id/internal_company_id/
--         assigned_user_id de outra account -> erro do trigger de
--         tenancy, ticket NÃO alterado (transação inteira revertida).
--
--  9. add_internal_ticket_comment:
--       - actor viewer -> 42501.
--       - body vazio/só espaço -> 22023.
--       - agent sem envolvimento no ticket -> 42501.
--       - agent envolvido (qualquer uma das 3 condições) -> sucesso;
--         SELECT count(*) FROM internal_ticket_events WHERE
--         ticket_id='<id>' AND event_type='comment_added' -> +1;
--         payload contém só {"comment_id": "..."}, nunca o body.
--       - ticket de outra account -> P0002, nem comentário nem evento
--         criados.
--
-- 10. Rollback íntegro em qualquer falha simulada — para cada uma das
--     3 funções, forçar um erro no ÚLTIMO INSERT (ex.: FK de
--     catálogo apontando para uma linha que é apagada por outra
--     sessão entre o SELECT e o INSERT — cenário artificial só para o
--     teste) e confirmar que NENHUM efeito parcial persiste: nenhum
--     ticket/comentário órfão sem seu evento, nenhum número de
--     internal_code "gasto" sem um ticket correspondente,
--     internal_tickets sem nenhuma linha alterada quando
--     update_internal_ticket falha no meio.
-- ============================================================
