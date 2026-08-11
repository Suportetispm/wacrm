-- ============================================================
-- 049_ticket_operations
--
-- FASE 6E.2 — RPCs operacionais de ticket (assumir, transferir fila,
-- transferir atendente, aguardar cliente, retomar, encerrar/
-- finalizar) e a correção de RLS que a auditoria da fase 6E.1
-- encontrou. Não cria tabela, não cria enum, não altera CHECK
-- nenhum, não toca em migration 048.
--
-- MODELO OPERACIONAL (decidido na fase 6E.1, sem schema novo):
--
--   Na fila            tickets.status='open'   assigned_agent_id=NULL  conversations.status='pending'
--   Em atendimento      tickets.status='open'   assigned_agent_id=X     conversations.status='in_progress'
--   Aguardando cliente  tickets.status='pending'                        conversations.status='waiting_customer'
--   Encerrado           tickets.status='closed'                        conversations.status='closed'
--   Finalizado          tickets.status='closed'                        conversations.status='finalized'
--
-- conversations.status continua sem sincronização automática com
-- tickets.status em geral (045) — só as RPCs abaixo, deliberadamente,
-- escrevem os dois juntos, na mesma transação, para representar esses
-- cinco estados operacionais sem precisar de coluna nova.
--
-- Todas as RPCs abaixo:
--   - SECURITY DEFINER, auth.uid() interno, nunca um p_actor_user_id
--     vindo do client;
--   - resolvem a conta/papel/status do CHAMADOR via profiles+accounts
--     (mesmo padrão de 018_account_member_rpcs.sql), e adicionalmente
--     exigem profiles.is_active e accounts.is_active (que 018 não
--     tinha porque é anterior à 048);
--   - buscam o ticket com `WHERE id = p_ticket_id AND account_id =
--     <conta do chamador> FOR UPDATE` — um ticket de outra conta
--     simplesmente não é encontrado (nunca "existe mas é de outra
--     empresa"), e o lock serializa concorrência na mesma linha;
--   - só chegam a escrever em `conversations`/`ticket_events` DEPOIS
--     de toda validação passar, na mesma transação da RPC;
--   - reusam os event_type já existentes em ticket_events (nenhum
--     CHECK é alterado).
-- ------------------------------------------------------------

-- ============================================================
-- PARTE A — CORREÇÃO DE RLS (tickets_select / ticket_events_select)
--
-- Gap encontrado na auditoria 6E.1: a checagem de acesso de agent via
-- fila (`EXISTS (SELECT 1 FROM queue_members qm WHERE qm.queue_id=...
-- AND qm.user_id=auth.uid() AND qm.account_id=...)`) nunca exigia
-- `qm.is_active` — um agente removido de uma fila (queue_members.
-- is_active=false) continuava enxergando os tickets daquela fila.
-- Único ajuste: adicionar `AND qm.is_active` nas duas policies.
-- Nenhuma outra regra muda — admin/owner/viewer continuam vendo tudo
-- da conta, agent continua vendo o que está atribuído a ele
-- independentemente de fila.
-- ============================================================

DROP POLICY IF EXISTS tickets_select ON tickets;
CREATE POLICY tickets_select ON tickets FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
    OR (
      is_account_member(account_id, 'agent') AND NOT is_account_member(account_id, 'admin')
      AND (
        assigned_agent_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM queue_members qm
          WHERE qm.queue_id = tickets.queue_id
            AND qm.user_id = auth.uid()
            AND qm.account_id = tickets.account_id
            AND qm.is_active
        )
      )
    )
  );

DROP POLICY IF EXISTS ticket_events_select ON ticket_events;
CREATE POLICY ticket_events_select ON ticket_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tickets t
      WHERE t.id = ticket_events.ticket_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (is_account_member(t.account_id) AND NOT is_account_member(t.account_id, 'agent'))
          OR (
            is_account_member(t.account_id, 'agent') AND NOT is_account_member(t.account_id, 'admin')
            AND (
              t.assigned_agent_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM queue_members qm
                WHERE qm.queue_id = t.queue_id
                  AND qm.user_id = auth.uid()
                  AND qm.account_id = t.account_id
                  AND qm.is_active
              )
            )
          )
        )
    )
  );

-- ============================================================
-- PARTE B — RPCs OPERACIONAIS
-- ============================================================

-- ============================================================
-- CLAIM_TICKET(p_ticket_id) — "Assumir atendimento"
--
-- Exige ticket.queue_id (nunca NULL) e a fila ativa — tanto para
-- agent quanto para admin/owner, conforme decidido na fase 6E.1
-- (seção 11: fila inativa nunca pode ser assumida, só visualizada).
-- Agent precisa ser membro ATIVO dessa fila; admin/owner assume
-- qualquer ticket de fila ativa da própria conta, sem precisar ser
-- membro. `FOR UPDATE` na linha do ticket serializa dois claims
-- concorrentes: o segundo chamador só prossegue depois que o primeiro
-- commitou, e nesse ponto assigned_agent_id já não é mais NULL — o
-- segundo recebe 23505, nunca sobrescreve silenciosamente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ticket(
  p_ticket_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
  v_queue_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot claim tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;

  -- Only 'open' (Na fila / Em atendimento with no assignee yet) can
  -- be claimed — 'pending' means "Aguardando cliente" (already has
  -- an assignee by construction, see mark_ticket_waiting_customer)
  -- and must go through resume_ticket instead, not be silently
  -- re-claimed here; 'closed' is terminal.
  IF v_ticket.status <> 'open' THEN
    RAISE EXCEPTION 'Ticket is not available to claim (must be open)' USING ERRCODE = '22023';
  END IF;

  IF v_ticket.queue_id IS NULL THEN
    RAISE EXCEPTION 'Ticket has no queue; assign a queue before claiming' USING ERRCODE = '22023';
  END IF;

  SELECT is_active INTO v_queue_active
  FROM public.queues
  WHERE id = v_ticket.queue_id AND account_id = v_caller_account_id;

  IF NOT FOUND OR NOT v_queue_active THEN
    RAISE EXCEPTION 'Ticket''s queue is not active' USING ERRCODE = '22023';
  END IF;

  IF NOT v_is_admin THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.queue_members qm
      WHERE qm.queue_id = v_ticket.queue_id
        AND qm.user_id = v_caller_id
        AND qm.account_id = v_caller_account_id
        AND qm.is_active
    ) THEN
      RAISE EXCEPTION 'Caller is not an active member of this ticket''s queue' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_ticket.assigned_agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'Ticket is already assigned' USING ERRCODE = '23505';
  END IF;

  UPDATE public.tickets
  SET assigned_agent_id = v_caller_id,
      status = 'open',
      pending_at = NULL
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  -- Defense in depth: account_id is repeated in the WHERE even though
  -- v_ticket.conversation_id was already resolved from a row we
  -- already confirmed belongs to v_caller_account_id — this RPC is
  -- SECURITY DEFINER and must not lean on that alone. NOT FOUND here
  -- would mean the conversation row itself is inconsistent with its
  -- own ticket's account_id, which should never happen; surfaced as
  -- an explicit error instead of a silent no-op cross-tenant write.
  UPDATE public.conversations
  SET status = 'in_progress'
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, to_value, payload)
  VALUES (v_caller_account_id, p_ticket_id, 'assigned', v_caller_id, v_caller_id::text, '{}'::jsonb);

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.claim_ticket(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_ticket(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ticket(UUID) TO authenticated;

-- ============================================================
-- TRANSFER_TICKET_QUEUE(p_ticket_id, p_queue_id) — "Transferir fila"
--
-- admin/owner transferem qualquer ticket da conta; agent só um
-- ticket ao qual já tem acesso pelas mesmas regras de tickets_select
-- (atribuído a ele OU membro ativo da fila ATUAL do ticket). A fila
-- de destino precisa existir, ser da mesma conta e estar ativa —
-- nunca é possível transferir PARA uma fila inativa (seção 11).
-- Volta o ticket para "Na fila": limpa assigned_agent_id, status
-- volta a 'open', pending_at é limpo (a linha pode estar saindo de
-- 'pending' — o CHECK biconditional exige pending_at NULL fora de
-- status='pending').
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_ticket_queue(
  p_ticket_id UUID,
  p_queue_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
  v_old_queue_id UUID;
  v_target_queue_active BOOLEAN;
  v_has_access BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot transfer tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_queue_id IS NULL THEN
    RAISE EXCEPTION 'queue_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;

  IF v_ticket.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot transfer a closed ticket' USING ERRCODE = '22023';
  END IF;

  v_old_queue_id := v_ticket.queue_id;

  -- Transferring to the ticket's own current queue is a no-op request
  -- that would otherwise still clear assigned_agent_id and bounce
  -- conversations.status back to 'pending' — real side effects for
  -- zero actual change. Reject before touching anything.
  IF p_queue_id IS NOT DISTINCT FROM v_old_queue_id THEN
    RAISE EXCEPTION 'Ticket is already in this queue' USING ERRCODE = '22023';
  END IF;

  IF NOT v_is_admin THEN
    v_has_access := (v_ticket.assigned_agent_id = v_caller_id)
      OR (
        v_ticket.queue_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.queue_members qm
          WHERE qm.queue_id = v_ticket.queue_id
            AND qm.user_id = v_caller_id
            AND qm.account_id = v_caller_account_id
            AND qm.is_active
        )
      );
    IF NOT v_has_access THEN
      RAISE EXCEPTION 'Caller cannot transfer this ticket' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT is_active INTO v_target_queue_active
  FROM public.queues
  WHERE id = p_queue_id AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target queue not found in this account' USING ERRCODE = '22023';
  END IF;
  IF NOT v_target_queue_active THEN
    RAISE EXCEPTION 'Target queue is not active' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tickets
  SET queue_id = p_queue_id,
      assigned_agent_id = NULL,
      status = 'open',
      pending_at = NULL
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  UPDATE public.conversations
  SET status = 'pending'
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value, payload)
  VALUES (
    v_caller_account_id, p_ticket_id, 'transferred_queue', v_caller_id,
    v_old_queue_id::text, p_queue_id::text,
    jsonb_build_object('from_queue_id', v_old_queue_id, 'to_queue_id', p_queue_id)
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.transfer_ticket_queue(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_ticket_queue(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_ticket_queue(UUID, UUID) TO authenticated;

-- ============================================================
-- TRANSFER_TICKET_AGENT(p_ticket_id, p_agent_user_id) —
-- "Transferir atendente"
--
-- Só admin/owner ou o agente ATUALMENTE responsável pelo ticket pode
-- executar. Alvo precisa: existir na mesma conta, estar ativo, ter
-- account_role IN ('agent','admin') — nunca owner/viewer. Se o ticket
-- tem fila e o alvo é 'agent', o alvo precisa ser membro ativo dessa
-- fila; um alvo 'admin' é isento dessa exigência — consistente com
-- tickets_select, onde admin já enxerga/opera qualquer ticket da
-- conta independentemente de fila.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_ticket_agent(
  p_ticket_id UUID,
  p_agent_user_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
  v_old_agent_id UUID;
  v_queue_active BOOLEAN;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot transfer tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_agent_user_id IS NULL THEN
    RAISE EXCEPTION 'agent_user_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;

  IF v_ticket.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot transfer a closed ticket' USING ERRCODE = '22023';
  END IF;

  -- A ticket sitting in an inactive queue can still be viewed (for
  -- management) but never acted on — same rule already enforced by
  -- claim_ticket; without this check, transfer_ticket_agent would be
  -- a back door to assign/reassign an agent inside a paused/archived
  -- queue's ticket.
  IF v_ticket.queue_id IS NOT NULL THEN
    SELECT is_active INTO v_queue_active
    FROM public.queues
    WHERE id = v_ticket.queue_id AND account_id = v_caller_account_id;

    IF NOT FOUND OR NOT v_queue_active THEN
      RAISE EXCEPTION 'Ticket''s queue is not active' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NOT v_is_admin AND v_ticket.assigned_agent_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the currently assigned agent or an admin can transfer this ticket' USING ERRCODE = '42501';
  END IF;

  v_old_agent_id := v_ticket.assigned_agent_id;

  -- Transferring to the agent who already holds the ticket is a
  -- no-op request — reject before touching anything or logging a
  -- misleading transferred_agent event with from==to.
  IF p_agent_user_id IS NOT DISTINCT FROM v_old_agent_id THEN
    RAISE EXCEPTION 'Ticket is already assigned to this agent' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, is_active
    INTO v_target_account_id, v_target_role, v_target_active
  FROM public.profiles
  WHERE user_id = p_agent_user_id;

  IF NOT FOUND OR v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target agent does not belong to this account' USING ERRCODE = '22023';
  END IF;
  IF NOT v_target_active THEN
    RAISE EXCEPTION 'Target agent is not active' USING ERRCODE = '22023';
  END IF;
  IF v_target_role NOT IN ('agent', 'admin') THEN
    RAISE EXCEPTION 'Target must have the agent or admin role' USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'agent' AND v_ticket.queue_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.queue_members qm
      WHERE qm.queue_id = v_ticket.queue_id
        AND qm.user_id = p_agent_user_id
        AND qm.account_id = v_caller_account_id
        AND qm.is_active
    ) THEN
      RAISE EXCEPTION 'Target agent is not an active member of this ticket''s queue' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.tickets
  SET assigned_agent_id = p_agent_user_id,
      status = 'open',
      pending_at = NULL
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  UPDATE public.conversations
  SET status = 'in_progress'
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value, payload)
  VALUES (
    v_caller_account_id, p_ticket_id, 'transferred_agent', v_caller_id,
    v_old_agent_id::text, p_agent_user_id::text,
    jsonb_build_object('from_agent_id', v_old_agent_id, 'to_agent_id', p_agent_user_id)
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.transfer_ticket_agent(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_ticket_agent(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_ticket_agent(UUID, UUID) TO authenticated;

-- ============================================================
-- MARK_TICKET_WAITING_CUSTOMER(p_ticket_id) — "Aguardar cliente"
--
-- Exige um ticket já atribuído (não faz sentido "aguardar cliente"
-- num ticket sem responsável) e não fechado. Só o agente responsável
-- ou um admin/owner. Reusa event_type='status_changed' — nenhum tipo
-- novo. from_value/to_value refletem a transição real de
-- tickets.status (o chamador pode, em tese, já estar em 'pending';
-- não há necessidade de travar nisso porque não há nenhuma regra do
-- produto que dependa de vir exatamente de 'open').
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_ticket_waiting_customer(
  p_ticket_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
  v_old_status TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot manage tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;
  -- Exactly 'open' -> 'pending'. A ticket already 'pending' must go
  -- through resume_ticket first — calling this again would log a
  -- misleading status_changed ('pending' -> 'pending'), reset
  -- pending_at to "now" for no real transition, and re-fire
  -- conversations.status='waiting_customer' redundantly.
  IF v_ticket.status <> 'open' THEN
    RAISE EXCEPTION 'Ticket must be open (in progress) to wait on the customer' USING ERRCODE = '22023';
  END IF;
  IF v_ticket.assigned_agent_id IS NULL THEN
    RAISE EXCEPTION 'Ticket must be assigned before it can wait on the customer' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_admin AND v_ticket.assigned_agent_id <> v_caller_id THEN
    RAISE EXCEPTION 'Only the assigned agent or an admin can do this' USING ERRCODE = '42501';
  END IF;

  v_old_status := v_ticket.status;

  UPDATE public.tickets
  SET status = 'pending',
      pending_at = now()
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  UPDATE public.conversations
  SET status = 'waiting_customer'
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value, payload)
  VALUES (
    v_caller_account_id, p_ticket_id, 'status_changed', v_caller_id,
    v_old_status, 'pending',
    jsonb_build_object('conversation_status', 'waiting_customer')
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.mark_ticket_waiting_customer(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_ticket_waiting_customer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_ticket_waiting_customer(UUID) TO authenticated;

-- ============================================================
-- RESUME_TICKET(p_ticket_id) — "Retomar atendimento"
--
-- Único caminho de volta de 'pending' ('Aguardando cliente') para
-- 'open' ('Em atendimento'). Exige ticket.status='pending'
-- exatamente. Só o agente responsável ou admin/owner. Reusa
-- event_type='status_changed'.
-- ============================================================
CREATE OR REPLACE FUNCTION public.resume_ticket(
  p_ticket_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot manage tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;
  IF v_ticket.status <> 'pending' THEN
    RAISE EXCEPTION 'Ticket is not waiting on the customer' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_admin AND v_ticket.assigned_agent_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the assigned agent or an admin can do this' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tickets
  SET status = 'open',
      pending_at = NULL
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  UPDATE public.conversations
  SET status = 'in_progress'
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, from_value, to_value, payload)
  VALUES (v_caller_account_id, p_ticket_id, 'status_changed', v_caller_id, 'pending', 'open', '{}'::jsonb);

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.resume_ticket(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resume_ticket(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_ticket(UUID) TO authenticated;

-- ============================================================
-- CLOSE_TICKET(p_ticket_id, p_close_reason, p_finalize) —
-- "Encerrar"/"Finalizar"
--
-- Único caminho de saída para 'closed'. Só o agente responsável ou
-- admin/owner. p_finalize decide se conversations.status vira
-- 'closed' ou 'finalized' — a distinção de produto pedida na fase
-- 6E.1, resolvida inteiramente com o enum já existente de
-- conversations.status, sem tocar tickets.status além do próprio
-- 'closed'. close_reason é sanitizado (trim, string vazia vira NULL,
-- limite de 500 caracteres) — nunca token/secret, é texto livre do
-- operador, não algo que precise disso por natureza, só um limite
-- de tamanho razoável.
-- ============================================================
CREATE OR REPLACE FUNCTION public.close_ticket(
  p_ticket_id UUID,
  p_close_reason TEXT,
  p_finalize BOOLEAN DEFAULT false
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_is_admin BOOLEAN;
  v_ticket tickets;
  v_trimmed_reason TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot manage tickets' USING ERRCODE = '42501';
  END IF;
  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_finalize IS NULL THEN
    RAISE EXCEPTION 'finalize must be true or false' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found' USING ERRCODE = '22023';
  END IF;
  IF v_ticket.status = 'closed' THEN
    RAISE EXCEPTION 'Ticket is already closed' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_admin AND v_ticket.assigned_agent_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the assigned agent or an admin can close this ticket' USING ERRCODE = '42501';
  END IF;

  v_trimmed_reason := NULLIF(btrim(COALESCE(p_close_reason, '')), '');
  IF v_trimmed_reason IS NOT NULL AND length(v_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'close_reason must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tickets
  SET status = 'closed',
      closed_at = now(),
      closed_by = v_caller_id,
      close_reason = v_trimmed_reason,
      pending_at = NULL
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  UPDATE public.conversations
  SET status = CASE WHEN p_finalize THEN 'finalized' ELSE 'closed' END
  WHERE id = v_ticket.conversation_id
    AND account_id = v_caller_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found in this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_events (account_id, ticket_id, event_type, actor_user_id, to_value, payload)
  VALUES (
    v_caller_account_id, p_ticket_id, 'closed', v_caller_id,
    CASE WHEN p_finalize THEN 'finalized' ELSE 'closed' END,
    jsonb_build_object('finalized', p_finalize)
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- REABERTURA — deliberadamente NÃO implementada nesta fase (6E.2).
-- ticket_events já suporta 'reopened' no CHECK (desde 040) e
-- continua suportando — nada foi removido. Fica para uma fase
-- posterior, por pedido explícito.
-- ============================================================

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — ver o mesmo aviso em
-- 034_fix_profiles_update_rls.sql). Rodar contra um ambiente de
-- staging real, nunca produção, antes/depois de aplicar esta
-- migration. Nenhum destes passos é executado por esta migration.
--
--  1. RLS is_active (contexto: dois profiles agent na mesma fila,
--     um com queue_members.is_active=false):
--       - o agent com queue_members.is_active=false NÃO deve ver,
--         via SELECT em tickets, um ticket daquela fila que não
--         esteja atribuído a ele.
--
--  2. claim_ticket:
--       - agent membro ativo da fila do ticket -> sucesso, ticket
--         volta com assigned_agent_id = agent, status 'open';
--         conversations.status vira 'in_progress'; ticket_events
--         ganha uma linha 'assigned'.
--       - agent que NÃO é membro da fila do ticket -> 42501.
--       - agent membro mas com queue_members.is_active=false -> 42501.
--       - agent contra ticket com queue_id NULL -> 22023.
--       - admin contra ticket de fila ativa, sem ser membro -> sucesso.
--       - admin/agent contra ticket de fila com is_active=false -> 22023.
--       - ticket já com assigned_agent_id preenchido -> 23505.
--       - ticket status='pending' (aguardando cliente) -> 22023
--         (precisa passar por resume_ticket antes de poder ser
--         reivindicado de novo).
--       - ticket status='closed' -> 22023.
--       - duas sessões chamando claim_ticket no mesmo ticket ao mesmo
--         tempo (duas conexões psql, uma trava BEGIN; SELECT
--         claim_ticket(...); a outra só prossegue depois do COMMIT/
--         ROLLBACK da primeira) -> só uma tem sucesso, a outra recebe
--         23505 (ou 22023 se o ticket foi fechado no meio).
--
--  3. transfer_ticket_queue:
--       - admin, fila destino ativa da mesma conta -> sucesso,
--         assigned_agent_id limpo, status 'open', conversations
--         'pending', ticket_events 'transferred_queue' com
--         from_queue_id/to_queue_id em payload.
--       - fila destino de OUTRA conta -> 22023 ("not found").
--       - fila destino com is_active=false -> 22023.
--       - fila destino IGUAL à fila atual do ticket -> 22023, sem
--         limpar assigned_agent_id nem mudar conversations.status
--         (nenhuma linha deve mudar além do erro).
--       - agent sem acesso ao ticket (não atribuído, não membro da
--         fila atual) -> 42501.
--       - ticket status='closed' -> 22023.
--
--  4. transfer_ticket_agent:
--       - admin transfere para agent membro ativo da fila -> sucesso.
--       - admin transfere para outro admin (não precisa ser membro
--         da fila) -> sucesso.
--       - alvo profile.is_active=false -> 22023.
--       - alvo de outra conta -> 22023.
--       - alvo agent que não é membro da fila do ticket -> 22023.
--       - alvo account_role='viewer' ou 'owner' -> 22023.
--       - alvo IGUAL ao assigned_agent_id atual -> 22023 (no-op
--         rejeitado, nenhum evento transferred_agent gerado).
--       - ticket.queue_id aponta para fila com is_active=false
--         (mesmo que o alvo seja membro dela) -> 22023.
--       - chamador agent que não é o assigned_agent_id atual -> 42501.
--       - ticket status='closed' -> 22023.
--
--  5. mark_ticket_waiting_customer / resume_ticket:
--       - ticket 'open' + assigned -> mark_ticket_waiting_customer ->
--         tickets.status='pending', pending_at preenchido,
--         conversations.status='waiting_customer'.
--       - ticket sem assigned_agent_id -> mark_ticket_waiting_customer
--         -> 22023.
--       - ticket já 'pending' -> mark_ticket_waiting_customer -> 22023
--         (precisa de resume_ticket antes; nenhum status_changed
--         duplicado é gravado, pending_at não é redefinido).
--       - resume_ticket em ticket 'pending' -> tickets.status='open',
--         pending_at NULL, conversations.status='in_progress'.
--       - resume_ticket em ticket que não está 'pending' -> 22023.
--
--  6. close_ticket:
--       - p_finalize=false -> conversations.status='closed'.
--       - p_finalize=true -> conversations.status='finalized'.
--       - ticket já 'closed' -> 22023.
--       - chamador agent que não é o assigned_agent_id -> 42501.
--       - close_reason com 501+ caracteres -> 22023.
--
--  7. Todos os casos acima, repetidos com o chamador em uma conta
--     DIFERENTE da conta do ticket -> sempre "Ticket not found"
--     (22023), nunca um erro que confirme a existência do ticket.
--
--  8. Defesa cross-tenant em conversations (todas as 6 RPCs): forçar
--     artificialmente (só em staging, via UPDATE direto) uma
--     conversation cujo account_id não bate mais com o account_id do
--     ticket que a referencia, e então chamar qualquer uma das 6
--     RPCs sobre esse ticket -> a RPC rejeita com "Conversation not
--     found in this account" (22023) e NÃO escreve em
--     conversations/ticket_events; confirmar via SELECT que a
--     conversation daquela outra conta permanece com seu status
--     original, inalterada.
-- ============================================================
