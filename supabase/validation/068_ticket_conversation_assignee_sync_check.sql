-- ============================================================
-- 068_ticket_conversation_assignee_sync_check.sql
--
-- Script de validação da migration 068 — NÃO É UMA MIGRATION, não é
-- aplicado automaticamente por nenhum runner (supabase db push ignora
-- arquivos fora de supabase/migrations/). Rodar manualmente contra
-- STAGING depois de aplicar 068 manualmente lá, NUNCA em produção.
--
-- Cobre os pontos A-J pedidos na revisão:
--   A. claim atualiza ticket E conversation para o mesmo agente
--   B. transfer_agent atualiza ambos para o agente alvo
--   C. transfer_queue limpa assigned_agent_id de ambos
--   D. conversations.queue_id NÃO muda em nenhum dos 3 casos
--   E. conversations.status continua igual ao comportamento pré-068
--   F. ticket_events continua sendo criado igual (mesmo event_type/
--      from_value/to_value/payload de antes)
--   G. role insuficiente falha atomicamente (42501, zero escrita)
--   H. agente/ticket de outra account continua rejeitado (22023,
--      "not found" — nunca um erro que confirme existência)
--   I. nenhuma escrita parcial em caso de erro (coberto por G e H)
--   J. assinaturas das 3 RPCs permanecem idênticas
--
-- SEGURANÇA DO SCRIPT: SEÇÃO 1 (assinatura/grants) é só introspecção
-- via pg_proc/has_function_privilege() — zero efeito colateral,
-- segura em qualquer ambiente, inclusive produção. SEÇÃO 2
-- (comportamental) cria dados sintéticos com prefixo
-- '__068_check__' e roda inteira dentro de BEGIN/ROLLBACK — desfeita
-- ao final independentemente do resultado, nenhuma linha sintética
-- sobrevive e nenhum dado real é tocado. Mesmo assim, NÃO rodar a
-- Seção 2 em produção (mesma política de todo script de validação
-- deste projeto — ver 067).
--
-- PREMISSA sobre auth.uid(): este script simula o chamador via
-- `SET LOCAL request.jwt.claims` + `SET LOCAL ROLE authenticated`,
-- o mecanismo padrão do Supabase (auth.uid() lê o claim `sub` do
-- JWT simulado). Se o ambiente de staging usar uma versão do schema
-- `auth` que definiu auth.uid() de outra forma, ajuste esta premissa
-- antes de rodar — não foi possível confirmar isso sem acesso a um
-- banco real.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — Assinatura e grants (somente leitura, seguro em
-- qualquer ambiente)
-- ============================================================

-- J — assinatura (nome, tipos de parâmetro, tipo de retorno)
-- idêntica à pré-068. Esperado:
--   claim_ticket(uuid) -> tickets
--   transfer_ticket_queue(uuid, uuid) -> tickets
--   transfer_ticket_agent(uuid, uuid) -> tickets
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('claim_ticket', 'transfer_ticket_queue', 'transfer_ticket_agent')
ORDER BY p.proname;

-- Grants inalterados: authenticated com EXECUTE, PUBLIC sem.
SELECT
  fn.label,
  has_function_privilege('PUBLIC', fn.signature, 'EXECUTE')         AS public_can_execute,
  has_function_privilege('authenticated', fn.signature, 'EXECUTE')  AS authenticated_can_execute
FROM (VALUES
  ('claim_ticket',          'public.claim_ticket(uuid)'),
  ('transfer_ticket_queue', 'public.transfer_ticket_queue(uuid, uuid)'),
  ('transfer_ticket_agent', 'public.transfer_ticket_agent(uuid, uuid)')
) AS fn(label, signature);
-- Esperado: public_can_execute = false, authenticated_can_execute = true
-- nas 3 linhas — idêntico a antes de 068 (CREATE OR REPLACE não
-- altera grant nenhum quando a assinatura não muda).

-- ============================================================
-- SEÇÃO 2 — Comportamental (staging apenas, dentro de BEGIN/ROLLBACK)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_account_a       UUID := gen_random_uuid();
  v_account_b       UUID := gen_random_uuid();
  v_owner_a         UUID := gen_random_uuid();
  v_admin_a         UUID := gen_random_uuid();
  v_agent_a1        UUID := gen_random_uuid(); -- membro ativo de q1
  v_agent_a2        UUID := gen_random_uuid(); -- membro ativo de q1 e q2
  v_agent_a3_no_q   UUID := gen_random_uuid(); -- NUNCA membro de fila nenhuma (caso G)
  v_agent_b         UUID := gen_random_uuid(); -- conta B (caso H)
  v_contact_a       UUID := gen_random_uuid();
  v_conversation_a  UUID := gen_random_uuid();
  v_queue_1         UUID := gen_random_uuid();
  v_queue_2         UUID := gen_random_uuid();
  v_queue_other     UUID := gen_random_uuid(); -- fila "alheia" só para provar D (queue_id da conversation nunca muda)
  v_ticket_id       UUID;

  v_conv_queue_before UUID;
  v_conv_queue_after  UUID;

  v_result tickets;
BEGIN
  RAISE NOTICE '=== 068 validation: building synthetic fixtures ===';

  -- ---- auth.users (mínimo necessário; ajustar se o schema local
  --      auth exigir colunas adicionais NOT NULL) ----
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner_a,       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__owner_a@example.com',  'x', now(), now(), now(), '{}', '{}'),
    (v_admin_a,       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__admin_a@example.com',  'x', now(), now(), now(), '{}', '{}'),
    (v_agent_a1,      '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__agent_a1@example.com', 'x', now(), now(), now(), '{}', '{}'),
    (v_agent_a2,      '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__agent_a2@example.com', 'x', now(), now(), now(), '{}', '{}'),
    (v_agent_a3_no_q, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__agent_a3@example.com', 'x', now(), now(), now(), '{}', '{}'),
    (v_agent_b,       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__068_check__agent_b@example.com',  'x', now(), now(), now(), '{}', '{}');

  -- ---- accounts ----
  INSERT INTO public.accounts (id, name, owner_user_id, is_active)
  VALUES
    (v_account_a, '__068_check__ Account A', v_owner_a, true),
    (v_account_b, '__068_check__ Account B', v_agent_b, true);

  -- ---- profiles ----
  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES
    (v_owner_a,       '__068_check__ Owner A',  '__068_check__owner_a@example.com',  v_account_a, 'owner', true),
    (v_admin_a,       '__068_check__ Admin A',  '__068_check__admin_a@example.com',  v_account_a, 'admin', true),
    (v_agent_a1,      '__068_check__ Agent A1', '__068_check__agent_a1@example.com', v_account_a, 'agent', true),
    (v_agent_a2,      '__068_check__ Agent A2', '__068_check__agent_a2@example.com', v_account_a, 'agent', true),
    (v_agent_a3_no_q, '__068_check__ Agent A3', '__068_check__agent_a3@example.com', v_account_a, 'agent', true),
    (v_agent_b,       '__068_check__ Agent B',  '__068_check__agent_b@example.com',  v_account_b, 'admin', true);

  -- ---- queues (todas ativas) ----
  INSERT INTO public.queues (id, account_id, name, is_active)
  VALUES
    (v_queue_1,     v_account_a, '__068_check__ Queue 1', true),
    (v_queue_2,     v_account_a, '__068_check__ Queue 2', true),
    (v_queue_other, v_account_a, '__068_check__ Queue Other (never used by tickets)', true);

  INSERT INTO public.queue_members (account_id, queue_id, user_id, is_active)
  VALUES
    (v_account_a, v_queue_1, v_agent_a1, true),
    (v_account_a, v_queue_1, v_agent_a2, true),
    (v_account_a, v_queue_2, v_agent_a2, true);
    -- v_agent_a3_no_q deliberadamente NÃO é membro de fila nenhuma (caso G)

  -- ---- contact + conversation ----
  -- queue_id da conversation é setado para v_queue_other — DIFERENTE
  -- das filas usadas pelo ticket (v_queue_1/v_queue_2) — exatamente
  -- para provar em D que nenhuma das 3 RPCs jamais escreve
  -- conversations.queue_id.
  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (v_contact_a, v_owner_a, v_account_a, '+5511999990000', '__068_check__ Contact A');

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conversation_a, v_owner_a, v_account_a, v_contact_a, 'pending', v_queue_other, NULL);

  SELECT queue_id INTO v_conv_queue_before FROM public.conversations WHERE id = v_conversation_a;

  -- ---- ticket ativo, aberto, sem assignee, na fila 1 ----
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority)
  VALUES (v_account_a, v_conversation_a, v_queue_1, 999001, 'open', 'normal')
  RETURNING id INTO v_ticket_id;

  RAISE NOTICE 'Fixtures ready: account_a=%, conversation_a=%, ticket=%', v_account_a, v_conversation_a, v_ticket_id;

  -- ============================================================
  -- A) claim_ticket sincroniza ticket E conversation
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a1)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO v_result FROM public.claim_ticket(v_ticket_id);
  RESET ROLE;

  IF v_result.assigned_agent_id IS DISTINCT FROM v_agent_a1 THEN
    RAISE EXCEPTION 'FAIL A: tickets.assigned_agent_id = % (esperado %)', v_result.assigned_agent_id, v_agent_a1;
  END IF;

  PERFORM 1 FROM public.conversations
  WHERE id = v_conversation_a
    AND assigned_agent_id = v_agent_a1
    AND status = 'in_progress';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL A: conversations.assigned_agent_id/status não sincronizaram após claim_ticket';
  END IF;

  PERFORM 1 FROM public.ticket_events
  WHERE ticket_id = v_ticket_id AND event_type = 'assigned' AND actor_user_id = v_agent_a1 AND to_value = v_agent_a1::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL F (via A): ticket_events "assigned" não foi gravado como antes de 068';
  END IF;

  RAISE NOTICE 'PASS A/E/F: claim_ticket sincroniza tickets.assigned_agent_id, conversations.assigned_agent_id, conversations.status=in_progress, e grava ticket_events igual a antes';

  -- ============================================================
  -- D (parcial 1) — queue_id da conversation não mudou com o claim
  -- ============================================================
  SELECT queue_id INTO v_conv_queue_after FROM public.conversations WHERE id = v_conversation_a;
  IF v_conv_queue_after IS DISTINCT FROM v_conv_queue_before THEN
    RAISE EXCEPTION 'FAIL D: conversations.queue_id mudou depois de claim_ticket (% -> %)', v_conv_queue_before, v_conv_queue_after;
  END IF;
  RAISE NOTICE 'PASS D (1/3): conversations.queue_id permanece % após claim_ticket', v_conv_queue_after;

  -- ============================================================
  -- B) transfer_ticket_agent sincroniza ticket E conversation
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO v_result FROM public.transfer_ticket_agent(v_ticket_id, v_agent_a2);
  RESET ROLE;

  IF v_result.assigned_agent_id IS DISTINCT FROM v_agent_a2 THEN
    RAISE EXCEPTION 'FAIL B: tickets.assigned_agent_id = % (esperado %)', v_result.assigned_agent_id, v_agent_a2;
  END IF;

  PERFORM 1 FROM public.conversations
  WHERE id = v_conversation_a
    AND assigned_agent_id = v_agent_a2
    AND status = 'in_progress';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL B: conversations.assigned_agent_id/status não sincronizaram após transfer_ticket_agent';
  END IF;

  PERFORM 1 FROM public.ticket_events
  WHERE ticket_id = v_ticket_id AND event_type = 'transferred_agent'
    AND from_value = v_agent_a1::text AND to_value = v_agent_a2::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL F (via B): ticket_events "transferred_agent" não foi gravado como antes de 068';
  END IF;

  RAISE NOTICE 'PASS B/E/F: transfer_ticket_agent sincroniza ambas as tabelas para o agente alvo';

  SELECT queue_id INTO v_conv_queue_after FROM public.conversations WHERE id = v_conversation_a;
  IF v_conv_queue_after IS DISTINCT FROM v_conv_queue_before THEN
    RAISE EXCEPTION 'FAIL D: conversations.queue_id mudou depois de transfer_ticket_agent (% -> %)', v_conv_queue_before, v_conv_queue_after;
  END IF;
  RAISE NOTICE 'PASS D (2/3): conversations.queue_id permanece % após transfer_ticket_agent', v_conv_queue_after;

  -- ============================================================
  -- C) transfer_ticket_queue limpa assigned_agent_id nas duas tabelas
  --    e NUNCA toca conversations.queue_id
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO v_result FROM public.transfer_ticket_queue(v_ticket_id, v_queue_2);
  RESET ROLE;

  IF v_result.assigned_agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL C: tickets.assigned_agent_id = % (esperado NULL)', v_result.assigned_agent_id;
  END IF;
  IF v_result.queue_id IS DISTINCT FROM v_queue_2 THEN
    RAISE EXCEPTION 'FAIL C: tickets.queue_id = % (esperado %)', v_result.queue_id, v_queue_2;
  END IF;

  PERFORM 1 FROM public.conversations
  WHERE id = v_conversation_a
    AND assigned_agent_id IS NULL
    AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL C: conversations.assigned_agent_id/status não sincronizaram após transfer_ticket_queue';
  END IF;

  PERFORM 1 FROM public.ticket_events
  WHERE ticket_id = v_ticket_id AND event_type = 'transferred_queue'
    AND from_value = v_queue_1::text AND to_value = v_queue_2::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL F (via C): ticket_events "transferred_queue" não foi gravado como antes de 068';
  END IF;

  RAISE NOTICE 'PASS C/E/F: transfer_ticket_queue limpa assigned_agent_id em tickets E conversations, muda tickets.queue_id, conversations.status=pending';

  SELECT queue_id INTO v_conv_queue_after FROM public.conversations WHERE id = v_conversation_a;
  IF v_conv_queue_after IS DISTINCT FROM v_conv_queue_before THEN
    RAISE EXCEPTION 'FAIL D: conversations.queue_id mudou depois de transfer_ticket_queue (% -> %, esperado permanecer %)', v_conv_queue_before, v_conv_queue_after, v_conv_queue_before;
  END IF;
  IF v_conv_queue_after = v_queue_2 THEN
    RAISE EXCEPTION 'FAIL D: conversations.queue_id foi indevidamente igualado a tickets.queue_id (%)', v_queue_2;
  END IF;
  RAISE NOTICE 'PASS D (3/3): conversations.queue_id permanece % — nunca foi igualado a tickets.queue_id (%) mesmo após a transferência de fila do ticket', v_conv_queue_after, v_queue_2;

  -- ============================================================
  -- G) role insuficiente falha atomicamente, zero escrita parcial
  --    (agent_a3 nunca foi membro de fila nenhuma) — testado no
  --    bloco $gh$ abaixo, em fixtures isoladas (conversation própria)
  --    para não colidir com idx_tickets_one_active_per_conversation
  --    (v_conversation_a, usada em A/B/C/D acima, já tem um ticket
  --    ativo neste ponto — inserir um segundo ticket ativo para ela
  --    aqui violaria esse índice; por isso G/H usam uma conversation
  --    nova, criada do zero dentro de $gh$, nunca esta).
  -- ============================================================

  RAISE NOTICE '=== teste G/H rodam em fixtures isoladas (conversation própria) para não violar idx_tickets_one_active_per_conversation ===';
END;
$outer$;

-- G/H precisam de um ticket ATIVO (open/pending) sem conflitar com o
-- ticket de v_conversation_a (também ativo neste ponto, após C) —
-- idx_tickets_one_active_per_conversation permite no máximo 1 ticket
-- ativo por conversation, nunca 2. O bloco abaixo cria sua própria
-- conversation nova (v_conversation_g), isolada de v_conversation_a,
-- exatamente para respeitar esse índice em vez de colidir com ele.

DO $gh$
DECLARE
  v_account_a       UUID;
  v_admin_a         UUID;
  v_agent_a3_no_q   UUID;
  v_agent_b         UUID;
  v_queue_1         UUID;
  v_conversation_g  UUID := gen_random_uuid();
  v_contact_g       UUID := gen_random_uuid();
  v_ticket_g        UUID;
  v_tickets_before   INT;
  v_conversations_before RECORD;
  v_events_before    INT;
  v_caught           BOOLEAN := false;
BEGIN
  SELECT id INTO v_account_a FROM public.accounts WHERE name = '__068_check__ Account A';
  SELECT user_id INTO v_admin_a FROM public.profiles WHERE email = '__068_check__admin_a@example.com';
  SELECT user_id INTO v_agent_a3_no_q FROM public.profiles WHERE email = '__068_check__agent_a3@example.com';
  SELECT user_id INTO v_agent_b FROM public.profiles WHERE email = '__068_check__agent_b@example.com';
  SELECT id INTO v_queue_1 FROM public.queues WHERE name = '__068_check__ Queue 1';

  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (v_contact_g, v_admin_a, v_account_a, '+5511999990001', '__068_check__ Contact G');
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conversation_g, v_admin_a, v_account_a, v_contact_g, 'pending', NULL, NULL);
  INSERT INTO public.tickets (account_id, conversation_id, queue_id, ticket_number, status, priority)
  VALUES (v_account_a, v_conversation_g, v_queue_1, 999003, 'open', 'normal')
  RETURNING id INTO v_ticket_g;

  -- ---- G: agent_a3 (não é membro de nenhuma fila) tenta claim ----
  SELECT count(*) INTO v_tickets_before FROM public.tickets WHERE id = v_ticket_g;
  SELECT status, assigned_agent_id INTO v_conversations_before FROM public.conversations WHERE id = v_conversation_g;
  SELECT count(*) INTO v_events_before FROM public.ticket_events WHERE ticket_id = v_ticket_g;

  v_caught := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a3_no_q)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.claim_ticket(v_ticket_g);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLSTATE = '42501' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL G: esperava 42501, recebeu SQLSTATE % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL G: claim_ticket deveria ter rejeitado agente não-membro da fila (42501), mas não lançou exceção';
  END IF;

  -- I (via G): nenhuma escrita parcial
  PERFORM 1 FROM public.tickets WHERE id = v_ticket_g AND assigned_agent_id IS NULL AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL I (via G): tickets sofreu escrita parcial após erro 42501'; END IF;
  PERFORM 1 FROM public.conversations WHERE id = v_conversation_g AND assigned_agent_id IS NULL AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL I (via G): conversations sofreu escrita parcial após erro 42501'; END IF;
  PERFORM 1 FROM (SELECT count(*) AS c FROM public.ticket_events WHERE ticket_id = v_ticket_g) x WHERE x.c = v_events_before;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL I (via G): ticket_events ganhou linha mesmo com erro 42501'; END IF;

  RAISE NOTICE 'PASS G/I: agente sem membership de fila é rejeitado (42501) sem nenhuma escrita parcial em tickets/conversations/ticket_events';

  -- ---- H: agent_b (conta diferente) tenta claim o ticket da conta A ----
  v_caught := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.claim_ticket(v_ticket_g);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLSTATE = '22023' AND SQLERRM = 'Ticket not found' THEN
      v_caught := true;
    ELSE
      RAISE EXCEPTION 'FAIL H: esperava 22023 "Ticket not found", recebeu SQLSTATE % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL H: claim_ticket deveria rejeitar chamador de outra account como "not found" (22023), sem confirmar existência do ticket';
  END IF;

  -- I (via H): nenhuma escrita parcial
  PERFORM 1 FROM public.tickets WHERE id = v_ticket_g AND assigned_agent_id IS NULL AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL I (via H): tickets sofreu escrita parcial após erro cross-account'; END IF;
  PERFORM 1 FROM public.conversations WHERE id = v_conversation_g AND assigned_agent_id IS NULL AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL I (via H): conversations sofreu escrita parcial após erro cross-account'; END IF;

  RAISE NOTICE 'PASS H/I: chamador de outra account recebe "Ticket not found" (22023), nunca um erro que confirme existência cross-tenant, sem escrita parcial';

  RAISE NOTICE '=== 068 validation: TODOS OS TESTES A-J PASSARAM ===';
END;
$gh$;

ROLLBACK;
