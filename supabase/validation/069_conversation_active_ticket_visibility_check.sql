-- ============================================================
-- 069_conversation_active_ticket_visibility_check.sql
--
-- Script de validação da migration 069 — NÃO É UMA MIGRATION, não é
-- aplicado automaticamente por nenhum runner (supabase db push ignora
-- arquivos fora de supabase/migrations/). Rodar manualmente contra
-- STAGING depois de aplicar 069 manualmente lá, NUNCA em produção.
--
-- Cobre os pontos 1-8 pedidos na revisão do risco residual da Etapa 2:
--   1. conversation sem ticket ativo -> false
--   2. conversation com ticket 'open' -> true
--   3. conversation com ticket 'pending' -> true
--   4. conversation só com tickets 'closed' -> false
--   5. conversation de outra account -> false (não revela existência)
--   6. anon -> sem EXECUTE (introspecção de grants, Seção 1)
--   7. authenticated da própria account -> pode consultar existência
--   8. ticket ativo escondido por tickets_select -> existência
--      continua true (o ponto inteiro desta migration)
--
-- Os itens 9-13 do pedido (comportamento da Inbox: fluxo RPC normal
-- quando visível, nunca UPDATE raw / nunca RPC com ticket_id inventado
-- quando oculto, queue_id intocado, UAZAPI/Meta intocadas) são
-- cobertos pelos testes puros em
-- src/lib/inbox/active-ticket-visibility.test.ts e
-- src/components — este script só cobre a função SQL em si.
--
-- SEGURANÇA DO SCRIPT: SEÇÃO 1 (assinatura/grants) é só introspecção
-- via pg_proc/has_function_privilege() — zero efeito colateral,
-- segura em qualquer ambiente, inclusive produção. SEÇÃO 2
-- (comportamental) cria dados sintéticos com prefixo
-- '__069_check__' e roda inteira dentro de BEGIN/ROLLBACK — desfeita
-- ao final independentemente do resultado, nenhuma linha sintética
-- sobrevive e nenhum dado real é tocado. Mesmo assim, NÃO rodar a
-- Seção 2 em produção (mesma política de todo script de validação
-- deste projeto — ver 067/068).
--
-- PREMISSA sobre auth.uid(): este script simula o chamador via
-- `SET LOCAL request.jwt.claims` + `SET LOCAL ROLE authenticated`,
-- o mecanismo padrão do Supabase (auth.uid() lê o claim `sub` do
-- JWT simulado) — mesma premissa do check de 068.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — Assinatura e grants (somente leitura, seguro em
-- qualquer ambiente)
-- ============================================================

-- Assinatura esperada: conversation_has_active_ticket(uuid) -> boolean,
-- SECURITY DEFINER.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'conversation_has_active_ticket';

-- 6/7 — grants: PUBLIC/anon sem EXECUTE, authenticated com EXECUTE.
SELECT
  has_function_privilege('PUBLIC', 'public.conversation_has_active_ticket(uuid)', 'EXECUTE')         AS public_can_execute,
  has_function_privilege('anon', 'public.conversation_has_active_ticket(uuid)', 'EXECUTE')            AS anon_can_execute,
  has_function_privilege('authenticated', 'public.conversation_has_active_ticket(uuid)', 'EXECUTE')   AS authenticated_can_execute;
-- Esperado: public_can_execute = false, anon_can_execute = false,
-- authenticated_can_execute = true.

-- ============================================================
-- SEÇÃO 2 — Comportamental (staging apenas, dentro de BEGIN/ROLLBACK)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_account_a        UUID := gen_random_uuid();
  v_account_b         UUID := gen_random_uuid();
  v_owner_a           UUID := gen_random_uuid();
  v_agent_hidden      UUID := gen_random_uuid(); -- membro da fila DA CONVERSATION, não da fila do ticket, não assignee (caso 8)
  v_agent_ticket_q    UUID := gen_random_uuid(); -- membro da fila DO TICKET, para comparação de baseline
  v_agent_b           UUID := gen_random_uuid(); -- conta B (caso 5)

  v_contact_none      UUID := gen_random_uuid();
  v_contact_open      UUID := gen_random_uuid();
  v_contact_pending   UUID := gen_random_uuid();
  v_contact_closed    UUID := gen_random_uuid();
  v_contact_hidden    UUID := gen_random_uuid();

  v_conv_none         UUID := gen_random_uuid(); -- caso 1
  v_conv_open         UUID := gen_random_uuid(); -- caso 2
  v_conv_pending      UUID := gen_random_uuid(); -- caso 3
  v_conv_closed       UUID := gen_random_uuid(); -- caso 4
  v_conv_hidden       UUID := gen_random_uuid(); -- caso 8

  v_queue_conv        UUID := gen_random_uuid(); -- fila DA CONVERSATION (caso 8)
  v_queue_ticket       UUID := gen_random_uuid(); -- fila DO TICKET, diferente de v_queue_conv (caso 8)

  v_ticket_closed_id  UUID;
  v_ticket_hidden_id  UUID;

  v_result BOOLEAN;
  v_visible_rows INT;
BEGIN
  RAISE NOTICE '=== 069 validation: building synthetic fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner_a,        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__069_check__owner_a@example.com',        'x', now(), now(), now(), '{}', '{}'),
    (v_agent_hidden,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__069_check__agent_hidden@example.com',   'x', now(), now(), now(), '{}', '{}'),
    (v_agent_ticket_q, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__069_check__agent_ticket_q@example.com', 'x', now(), now(), now(), '{}', '{}'),
    (v_agent_b,        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__069_check__agent_b@example.com',        'x', now(), now(), now(), '{}', '{}');

  INSERT INTO public.accounts (id, name, owner_user_id, is_active)
  VALUES
    (v_account_a, '__069_check__ Account A', v_owner_a, true),
    (v_account_b, '__069_check__ Account B', v_agent_b, true);

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES
    (v_owner_a,        '__069_check__ Owner A',        '__069_check__owner_a@example.com',        v_account_a, 'owner', true),
    (v_agent_hidden,   '__069_check__ Agent Hidden',   '__069_check__agent_hidden@example.com',   v_account_a, 'agent', true),
    (v_agent_ticket_q, '__069_check__ Agent TicketQ',  '__069_check__agent_ticket_q@example.com', v_account_a, 'agent', true),
    (v_agent_b,        '__069_check__ Agent B',        '__069_check__agent_b@example.com',        v_account_b, 'admin', true);

  INSERT INTO public.queues (id, account_id, name, is_active)
  VALUES
    (v_queue_conv,   v_account_a, '__069_check__ Queue Conv',   true),
    (v_queue_ticket, v_account_a, '__069_check__ Queue Ticket', true);

  -- v_agent_hidden é membro só de v_queue_conv (a fila da conversation
  -- do caso 8) — deliberadamente NÃO membro de v_queue_ticket.
  INSERT INTO public.queue_members (account_id, queue_id, user_id, is_active)
  VALUES
    (v_account_a, v_queue_conv,   v_agent_hidden,   true),
    (v_account_a, v_queue_ticket, v_agent_ticket_q, true);

  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES
    (v_contact_none,    v_owner_a, v_account_a, '+5511900000001', '__069_check__ Contact None'),
    (v_contact_open,    v_owner_a, v_account_a, '+5511900000002', '__069_check__ Contact Open'),
    (v_contact_pending, v_owner_a, v_account_a, '+5511900000003', '__069_check__ Contact Pending'),
    (v_contact_closed,  v_owner_a, v_account_a, '+5511900000004', '__069_check__ Contact Closed'),
    (v_contact_hidden,  v_owner_a, v_account_a, '+5511900000005', '__069_check__ Contact Hidden');

  -- Caso 1: conversation sem ticket nenhum.
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_none, v_owner_a, v_account_a, v_contact_none, 'pending', NULL, NULL);

  -- Caso 2: conversation com ticket 'open'.
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_open, v_owner_a, v_account_a, v_contact_open, 'in_progress', NULL, NULL);
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority)
  VALUES (v_account_a, v_conv_open, NULL, 999101, 'open', 'normal');

  -- Caso 3: conversation com ticket 'pending'.
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_pending, v_owner_a, v_account_a, v_contact_pending, 'waiting_customer', NULL, v_owner_a);
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority, assigned_agent_id, pending_at)
  VALUES (v_account_a, v_conv_pending, NULL, 999102, 'pending', 'normal', v_owner_a, now());

  -- Caso 4: conversation só com ticket(s) 'closed'.
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_closed, v_owner_a, v_account_a, v_contact_closed, 'closed', NULL, NULL);
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority, closed_at)
  VALUES (v_account_a, v_conv_closed, NULL, 999103, 'closed', 'normal', now())
  RETURNING id INTO v_ticket_closed_id;

  -- Caso 8: conversation na fila v_queue_conv (agent_hidden é membro
  -- dela), ticket ATIVO na fila v_queue_ticket (agent_hidden NÃO é
  -- membro dela, e não é o assigned_agent) — a divergência de
  -- queue_id que motivou esta migration.
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_hidden, v_owner_a, v_account_a, v_contact_hidden, 'in_progress', v_queue_conv, NULL);
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority)
  VALUES (v_account_a, v_conv_hidden, v_queue_ticket, 999104, 'open', 'normal')
  RETURNING id INTO v_ticket_hidden_id;

  RAISE NOTICE 'Fixtures ready.';

  -- ============================================================
  -- 1) sem ticket ativo -> false
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_none) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 1: esperava false para conversation sem ticket, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 1: conversation sem ticket -> false';

  -- ============================================================
  -- 2) ticket 'open' -> true
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_open) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 2: esperava true para ticket open, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 2: conversation com ticket open -> true';

  -- ============================================================
  -- 3) ticket 'pending' -> true
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_pending) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 3: esperava true para ticket pending, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 3: conversation com ticket pending -> true';

  -- ============================================================
  -- 4) só ticket 'closed' -> false
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_closed) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 4: esperava false para conversation só com ticket closed, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 4: conversation com apenas ticket closed -> false';

  -- ============================================================
  -- 5) conversation de outra account -> false (não revela existência)
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_open) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 5: chamador de outra account deveria receber false, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 5: conversation de outra account -> false, sem revelar existência';

  -- ============================================================
  -- 7) authenticated da própria account -> consulta funciona
  --    (já demonstrado nos casos 1-4 acima com v_owner_a; reafirma
  --    com um agent comum, não-admin)
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_ticket_q)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_open) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 7: agent da própria account deveria conseguir consultar existência, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 7: agent comum da própria account consegue consultar existência';

  -- ============================================================
  -- 8) ticket ativo escondido por tickets_select -> continua true
  -- ============================================================
  -- 8a) confirma a premissa: agent_hidden NÃO vê o ticket via SELECT
  --     comum (RLS tickets_select) — senão o caso não testaria nada.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_hidden)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_visible_rows FROM public.tickets WHERE id = v_ticket_hidden_id;
  RESET ROLE;
  IF v_visible_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL 8 (premissa): agent_hidden não deveria enxergar o ticket via RLS comum, mas viu % linha(s) — fixture inválida', v_visible_rows;
  END IF;
  RAISE NOTICE 'PASS 8 (premissa): tickets_select realmente esconde o ticket de agent_hidden';

  -- 8b) mesmo assim, confirma que agent_hidden enxerga a conversation
  --     (é membro da fila dela) — senão o cenário nem chegaria na Inbox.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_hidden)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_visible_rows FROM public.conversations WHERE id = v_conv_hidden;
  RESET ROLE;
  IF v_visible_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL 8 (premissa): agent_hidden deveria enxergar a conversation (membro da fila dela), viu % linha(s) — fixture inválida', v_visible_rows;
  END IF;
  RAISE NOTICE 'PASS 8 (premissa): agent_hidden enxerga a conversation normalmente';

  -- 8c) o ponto central desta migration: mesmo sem enxergar o ticket,
  --     conversation_has_active_ticket() ainda responde true.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_hidden)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.conversation_has_active_ticket(v_conv_hidden) INTO v_result;
  RESET ROLE;
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 8: conversation_has_active_ticket deveria retornar true mesmo com o ticket oculto pela RLS, obteve %', v_result;
  END IF;
  RAISE NOTICE 'PASS 8: conversation_has_active_ticket detecta o ticket ativo mesmo oculto por tickets_select — risco residual fechado';

  RAISE NOTICE '=== 069 validation: TODOS OS TESTES 1-8 PASSARAM ===';
END;
$outer$;

ROLLBACK;
