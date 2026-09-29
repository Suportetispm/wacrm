-- ============================================================
-- 068_ticket_conversation_assignee_sync
--
-- Etapa 1/2 da correção do gap de sincronização Inbox ↔ Tickets
-- (auditoria aprovada nesta sessão — ver a análise arquitetural
-- anterior). Corrige SOMENTE esta inconsistência confirmada:
--
--   As RPCs de tickets (049_ticket_operations.sql) já escrevem
--   tickets.assigned_agent_id, e já espelham tickets.status em
--   conversations.status na mesma transação — mas NUNCA escrevem
--   conversations.assigned_agent_id. Isso significa que, mesmo usando
--   só a tela /tickets (sem tocar na Inbox), conversations.
--   assigned_agent_id já ficava desatualizado em relação a
--   tickets.assigned_agent_id.
--
-- ESCOPO DESTA MIGRATION (estritamente):
--   CREATE OR REPLACE em exatamente 3 funções — claim_ticket,
--   transfer_ticket_agent, transfer_ticket_queue — cada uma ganhando
--   APENAS uma cláusula a mais no UPDATE de `conversations` que ela
--   já fazia. Nenhuma outra linha muda.
--
-- BASE: o corpo efetivo/vigente de cada função, conferido linha a
-- linha contra 049_ticket_operations.sql — nenhuma migration entre
-- 050 e 067 redefine claim_ticket, transfer_ticket_agent ou
-- transfer_ticket_queue (confirmado por grep em todo supabase/
-- migrations/*.sql; 050/051/054 só as MENCIONAM em comentário,
-- nunca com CREATE OR REPLACE). A versão de 049 É a versão vigente —
-- nada de lógica antiga sendo ressuscitada por cima de hotfix
-- nenhum.
--
-- NÃO MUDA em nenhuma das 3 funções: assinatura, parâmetros, tipo de
-- retorno (tickets), LANGUAGE/SECURITY/search_path, nenhuma regra de
-- autorização (role mínimo, admin-bypass, membership de fila, fila
-- ativa, tenancy do alvo), nenhuma validação de erro/ERRCODE, o
-- SELECT ... FOR UPDATE (mantido exatamente onde já estava), o
-- UPDATE de tickets.*, tickets.status, conversations.status,
-- conversations.queue_id (nunca tocado, nem antes nem depois), nem
-- a linha inserida em ticket_events. Owner/REVOKE/GRANT reafirmados
-- de forma idêntica aos de 049, só por idempotência (CREATE OR
-- REPLACE já preserva ambos quando a assinatura não muda).
--
-- Comportamento novo, por função:
--
--   claim_ticket(p_ticket_id):
--     conversations.assigned_agent_id = v_caller_id (mesmo agente
--     que passa a ser o assigned_agent_id do ticket).
--
--   transfer_ticket_agent(p_ticket_id, p_agent_user_id):
--     conversations.assigned_agent_id = p_agent_user_id (mesmo
--     agente alvo que passa a ser o assigned_agent_id do ticket).
--
--   transfer_ticket_queue(p_ticket_id, p_queue_id):
--     conversations.assigned_agent_id = NULL (mesmo valor que
--     tickets.assigned_agent_id já recebe nesta função — só estava
--     faltando espelhar em conversations). conversations.queue_id
--     continua INTOCADO por esta função, exatamente como hoje —
--     conversations.queue_id é fonte de verdade do Flow routing
--     (058_conversation_queue_routing.sql), desacoplada de tickets
--     por decisão de produto já auditada; esta migration não mexe
--     nisso.
--
-- IDEMPOTÊNCIA: CREATE OR REPLACE FUNCTION substitui o corpo inteiro;
-- REVOKE/GRANT são no-op quando já aplicados. Seguro reexecutar.
--
-- NÃO aplicada nesta etapa — revisão manual pendente antes de rodar
-- contra staging/produção. Script de validação separado em
-- supabase/validation/068_ticket_conversation_assignee_sync_check.sql
-- (não faz parte desta migration, não é aplicado por ela).
-- ============================================================

-- ============================================================
-- 1. claim_ticket(p_ticket_id) — "Assumir atendimento"
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
  --
  -- 068: assigned_agent_id is now mirrored here too — this was the
  -- confirmed gap (claim_ticket already set tickets.assigned_agent_id
  -- above, but conversations.assigned_agent_id never followed it).
  UPDATE public.conversations
  SET status = 'in_progress',
      assigned_agent_id = v_caller_id
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
REVOKE ALL ON FUNCTION public.claim_ticket(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_ticket(UUID) TO authenticated;

-- ============================================================
-- 2. transfer_ticket_queue(p_ticket_id, p_queue_id) — "Transferir fila"
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

  -- 068: assigned_agent_id mirrored here too — tickets.assigned_agent_id
  -- was already cleared above (a queue transfer always drops the
  -- current assignee), conversations.assigned_agent_id never followed
  -- it. conversations.queue_id is deliberately NOT touched by this
  -- function, exactly as before this migration — it is Flow routing's
  -- own source of truth (058_conversation_queue_routing.sql), not a
  -- mirror of tickets.queue_id.
  UPDATE public.conversations
  SET status = 'pending',
      assigned_agent_id = NULL
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
REVOKE ALL ON FUNCTION public.transfer_ticket_queue(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_ticket_queue(UUID, UUID) TO authenticated;

-- ============================================================
-- 3. transfer_ticket_agent(p_ticket_id, p_agent_user_id) —
--    "Transferir atendente"
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

  -- 068: assigned_agent_id mirrored here too — same confirmed gap as
  -- claim_ticket above.
  UPDATE public.conversations
  SET status = 'in_progress',
      assigned_agent_id = p_agent_user_id
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
REVOKE ALL ON FUNCTION public.transfer_ticket_agent(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_ticket_agent(UUID, UUID) TO authenticated;

-- ============================================================
-- VALIDAÇÃO MANUAL — rodar contra staging, nunca produção, antes de
-- aplicar em produção. Script completo e separado em
-- supabase/validation/068_ticket_conversation_assignee_sync_check.sql
-- (não faz parte desta migration, não é aplicado por ela).
-- ============================================================
