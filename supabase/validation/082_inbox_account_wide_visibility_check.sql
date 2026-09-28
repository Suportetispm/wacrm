-- ============================================================
-- 082_inbox_account_wide_visibility_check.sql
--
-- Verificação da migration 082 — rodar DEPOIS de aplicar.
--
--   SEÇÃO 1 — estrutural, só catálogo. Segura em produção.
--   SEÇÃO 2 — impersonação de usuários REAIS, SOMENTE SELECT, dentro
--             de BEGIN/ROLLBACK. Segura em produção (nada é escrito).
--   SEÇÃO 3 — comportamental com dados sintéticos (INSERT/UPDATE em
--             BEGIN/ROLLBACK). SÓ STAGING — NUNCA PRODUÇÃO (mesma
--             política de todo script de supabase/validation/).
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — estrutural (segura em produção)
-- ============================================================

SELECT policyname, cmd, permissive, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: exatamente 3 linhas.
--   conversations_insert — INALTERADA (is_account_member(account_id,'agent')).
--   conversations_select — qual = is_account_member(account_id)
--     (sem 'queue_members', sem 'assigned_agent_id').
--   conversations_update — qual = is_account_member(account_id,'agent')
--     (sem 'queue_members'); with_check IGUAL ao da 076
--     (is_account_member(...,'agent') AND (assigned_agent_id IS NULL
--     OR EXISTS profile da mesma account)).

-- Resumo booleano do mesmo conjunto
SELECT
  bool_and(qual NOT ILIKE '%queue_members%')                         AS nenhuma_regra_de_fila,
  bool_and(qual ILIKE '%is_account_member%')                         AS todas_por_account,
  bool_and(btrim(qual, ' ()') <> 'true')                             AS nenhuma_using_true,
  bool_or(policyname = 'conversations_update'
          AND with_check ILIKE '%FROM profiles p%'
          AND with_check ILIKE '%p.account_id = conversations.account_id%') AS update_with_check_mesma_account
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
  AND policyname IN ('conversations_select', 'conversations_update');
-- Esperado: 4 × true.

-- messages — INALTERADAS pela 082; seguem o isolamento da conversation
-- (a subquery em conversations também é filtrada pela RLS dela).
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'messages'
ORDER BY policyname;
-- Esperado: messages_select / messages_modify iguais à 017.

-- RLS continua habilitada
SELECT relname, relrowsecurity AS rls_enabled
FROM pg_class
WHERE oid IN ('public.conversations'::regclass, 'public.messages'::regclass);
-- Esperado: true / true.

-- Trigger de proteção de colunas intacto (queue_id etc. continuam bloqueados para authenticated)
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns presente e habilitado ('O').

-- Realtime
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('conversations', 'messages');
-- Esperado: 2 linhas.

-- ============================================================
-- SEÇÃO 2 — usuários REAIS, SOMENTE SELECT (segura em produção)
--
-- Substituir <USER_ID> por um vendedor real (ex.: Afonso, de
-- OUTLET - ARACAGI) e repetir para outro de outra unidade (ex.:
-- Kleyson, de OUTLET - COHAMA). Nada é gravado: só SELECT, e o bloco
-- termina em ROLLBACK.
-- ============================================================

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '<USER_ID>', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- 2a) Conversas visíveis, por account — deve aparecer SÓ a account do usuário
SELECT c.account_id, count(*) AS visiveis
FROM public.conversations c
GROUP BY c.account_id;

-- 2b) Mensagens visíveis, por account da conversa — mesma account só
SELECT c.account_id, count(m.id) AS mensagens_visiveis
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
GROUP BY c.account_id;

RESET ROLE;

-- 2c) Referência como postgres: total real da account do usuário
SELECT p.account_id, a.name, p.account_role, p.is_active,
       (SELECT count(*) FROM public.conversations c WHERE c.account_id = p.account_id) AS total_da_account
FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
WHERE p.user_id = '<USER_ID>';
-- Esperado: 2a tem 1 linha, account_id = 2c.account_id e
-- visiveis = 2c.total_da_account (profile e account ativos). 2b só
-- com essa mesma account_id.
ROLLBACK;

-- ============================================================
-- SEÇÃO 3 — comportamental sintético (SÓ STAGING, BEGIN/ROLLBACK)
-- Cobre os cenários A–H pedidos para a 082 + escrita (claim/status/
-- atribuição/envio) que depende de conversations_update/messages.
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_acc_a            UUID := gen_random_uuid();
  v_acc_b            UUID := gen_random_uuid();
  v_acc_c            UUID := gen_random_uuid(); -- account que será desativada

  v_owner_a          UUID := gen_random_uuid();
  v_admin_a          UUID := gen_random_uuid();
  v_agent_a1         UUID := gen_random_uuid(); -- membro da fila Q1
  v_agent_a2         UUID := gen_random_uuid(); -- SEM fila nenhuma
  v_agent_a_inactive UUID := gen_random_uuid(); -- profile inativo
  v_viewer_a         UUID := gen_random_uuid();
  v_agent_b          UUID := gen_random_uuid();
  v_agent_c          UUID := gen_random_uuid(); -- account inativa
  v_no_member        UUID := gen_random_uuid(); -- auth user sem profile

  v_q1               UUID := gen_random_uuid();
  v_q2               UUID := gen_random_uuid();

  v_ct_a1 UUID := gen_random_uuid(); v_ct_a2 UUID := gen_random_uuid();
  v_ct_a3 UUID := gen_random_uuid(); v_ct_a4 UUID := gen_random_uuid();
  v_ct_b  UUID := gen_random_uuid(); v_ct_c  UUID := gen_random_uuid();

  v_c_a_none         UUID := gen_random_uuid(); -- sem fila, sem responsável
  v_c_a_other_agent  UUID := gen_random_uuid(); -- sem fila, atribuída a agent_a1
  v_c_a_other_queue  UUID := gen_random_uuid(); -- fila Q1 (agent_a2 não é membro), sem responsável
  v_c_a_new          UUID := gen_random_uuid(); -- "chega" depois (H)
  v_c_b              UUID := gen_random_uuid();
  v_c_c              UUID := gen_random_uuid();

  v_a_convs          UUID[];
  v_n                INT;
BEGIN
  RAISE NOTICE '=== 082 validation: fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         '__082_check__' || u || '@example.com', 'x', now(), now(), now(), '{}', '{}'
  FROM unnest(ARRAY[v_owner_a, v_admin_a, v_agent_a1, v_agent_a2, v_agent_a_inactive,
                    v_viewer_a, v_agent_b, v_agent_c, v_no_member]) AS u;

  INSERT INTO public.accounts (id, name, owner_user_id, is_active) VALUES
    (v_acc_a, '__082_check__ Account A', v_owner_a, true),
    (v_acc_b, '__082_check__ Account B', v_agent_b, true),
    (v_acc_c, '__082_check__ Account C', v_agent_c, true);

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active) VALUES
    (v_owner_a,          '__082 Owner A',     '__082_check__' || v_owner_a          || '@example.com', v_acc_a, 'owner',  true),
    (v_admin_a,          '__082 Admin A',     '__082_check__' || v_admin_a          || '@example.com', v_acc_a, 'admin',  true),
    (v_agent_a1,         '__082 Agent A1',    '__082_check__' || v_agent_a1         || '@example.com', v_acc_a, 'agent',  true),
    (v_agent_a2,         '__082 Agent A2',    '__082_check__' || v_agent_a2         || '@example.com', v_acc_a, 'agent',  true),
    (v_agent_a_inactive, '__082 Agent A Off', '__082_check__' || v_agent_a_inactive || '@example.com', v_acc_a, 'agent',  true),
    (v_viewer_a,         '__082 Viewer A',    '__082_check__' || v_viewer_a         || '@example.com', v_acc_a, 'viewer', true),
    (v_agent_b,          '__082 Agent B',     '__082_check__' || v_agent_b          || '@example.com', v_acc_b, 'owner',  true),
    (v_agent_c,          '__082 Agent C',     '__082_check__' || v_agent_c          || '@example.com', v_acc_c, 'owner',  true);
  -- v_no_member: nenhum profile criado explicitamente.

  INSERT INTO public.queues (id, account_id, name, is_active) VALUES
    (v_q1, v_acc_a, '__082_check__ Q1', true),
    (v_q2, v_acc_a, '__082_check__ Q2', true);
  INSERT INTO public.queue_members (account_id, queue_id, user_id, is_active)
  VALUES (v_acc_a, v_q1, v_agent_a1, true);

  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
    (v_ct_a1, v_owner_a, v_acc_a, '+5598900082001', '__082 A1'),
    (v_ct_a2, v_owner_a, v_acc_a, '+5598900082002', '__082 A2'),
    (v_ct_a3, v_owner_a, v_acc_a, '+5598900082003', '__082 A3'),
    (v_ct_a4, v_owner_a, v_acc_a, '+5598900082004', '__082 A4'),
    (v_ct_b,  v_agent_b, v_acc_b, '+5598900082005', '__082 B'),
    (v_ct_c,  v_agent_c, v_acc_c, '+5598900082006', '__082 C');

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id) VALUES
    (v_c_a_none,        v_owner_a, v_acc_a, v_ct_a1, 'pending',     NULL, NULL),
    (v_c_a_other_agent, v_owner_a, v_acc_a, v_ct_a2, 'in_progress', NULL, v_agent_a1),
    (v_c_a_other_queue, v_owner_a, v_acc_a, v_ct_a3, 'pending',     v_q1, NULL),
    (v_c_b,             v_agent_b, v_acc_b, v_ct_b,  'pending',     NULL, NULL),
    (v_c_c,             v_agent_c, v_acc_c, v_ct_c,  'pending',     NULL, NULL);

  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
  SELECT c, 'customer', 'text', '__082_check__', '__082_check__' || c, 'delivered'
  FROM unnest(ARRAY[v_c_a_none, v_c_a_other_agent, v_c_a_other_queue, v_c_b, v_c_c]) AS c;

  -- Desativações DEPOIS das fixtures (evita qualquer guard de criação).
  UPDATE public.profiles SET is_active = false WHERE user_id = v_agent_a_inactive;
  UPDATE public.accounts SET is_active = false WHERE id = v_acc_c;

  v_a_convs := ARRAY[v_c_a_none, v_c_a_other_agent, v_c_a_other_queue];

  -- ============================================================
  -- A) agent A2 (sem fila) vê TODAS as conversas de A:
  --    sem fila/sem responsável, atribuída a outro, em fila alheia
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs);
  RESET ROLE;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL A: agent A2 deveria ver 3 conversas de A, viu %', v_n; END IF;
  RAISE NOTICE 'PASS A: agent sem fila vê conversa sem fila/sem responsável, atribuída a outro e de outra fila (3/3)';

  -- ============================================================
  -- B) agent A2 NÃO vê conversa de B; agent B NÃO vê conversas de A
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id IN (v_c_b, v_c_c);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL B1: agent A2 viu % conversa(s) de outra account', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL B2: usuário de B viu % conversa(s) de A', v_n; END IF;
  RAISE NOTICE 'PASS B: isolamento cross-account nos dois sentidos';

  -- ============================================================
  -- C) owner / admin de A continuam vendo tudo de A e nada de B
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs || v_c_b);
  RESET ROLE;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL C1: owner A deveria ver 3 (só A), viu %', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs || v_c_b);
  RESET ROLE;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL C2: admin A deveria ver 3 (só A), viu %', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_viewer_a)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs);
  RESET ROLE;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL C3: viewer A deveria ver 3 (leitura), viu %', v_n; END IF;
  RAISE NOTICE 'PASS C: owner/admin inalterados; viewer lê a account';

  -- ============================================================
  -- D) usuário inativo / account inativa não ganham acesso
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a_inactive)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL D1: profile inativo viu % conversa(s)', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_c)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_c;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL D2: usuário de account inativa viu a própria conversa'; END IF;
  RAISE NOTICE 'PASS D: profile inativo e account inativa sem acesso';

  -- ============================================================
  -- E) usuário sem membership não ganha acesso
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_no_member)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations
  WHERE id = ANY(v_a_convs || ARRAY[v_c_b, v_c_c]);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL E: usuário sem membership viu % conversa(s)', v_n; END IF;
  RAISE NOTICE 'PASS E: sem membership, sem acesso';

  -- ============================================================
  -- F) filtros por responsável/fila continuam funcionando como
  --    FILTRO de consulta (não como barreira)
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs) AND assigned_agent_id = v_agent_a1;
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL F1: filtro por responsável devolveu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs) AND assigned_agent_id IS NULL;
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL F2: filtro sem responsável devolveu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_a_convs) AND queue_id = v_q1;
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL F3: filtro por fila devolveu %', v_n; END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS F: filtros por responsável / sem responsável / fila funcionam sobre a visão completa';

  -- ============================================================
  -- G) messages seguem o isolamento da conversation/account
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id = ANY(v_a_convs);
  IF v_n <> 3 THEN RESET ROLE; RAISE EXCEPTION 'FAIL G1: agent A2 deveria ler as 3 mensagens de A, leu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id IN (v_c_b, v_c_c);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL G2: agent A2 leu % mensagem(ns) de outra account', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id = ANY(v_a_convs);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL G3: usuário de B leu % mensagem(ns) de A', v_n; END IF;
  RAISE NOTICE 'PASS G: messages isoladas por account, liberadas junto com a conversation';

  -- ============================================================
  -- H) nova conversa/mensagem "chegando" (INSERT como o webhook,
  --    service_role/postgres) é imediatamente SELECTável pelo agent
  --    da account — é exatamente a checagem que o Realtime
  --    (postgres_changes) aplica por assinante. Publicação: Seção 1.
  -- ============================================================
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status)
  VALUES (v_c_a_new, v_owner_a, v_acc_a, v_ct_a4, 'pending');
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
  VALUES (v_c_a_new, 'customer', 'text', '__082_check__', '__082_check__new', 'delivered');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_a_new;
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL H1: agent não enxerga a conversa recém-criada'; END IF;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id = v_c_a_new;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL H2: agent não enxerga a mensagem recém-criada'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_a_new;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL H3: usuário de B enxerga a conversa nova de A'; END IF;
  RAISE NOTICE 'PASS H: evento novo autorizado para a account certa e só para ela';

  -- ============================================================
  -- U) Escrita que a Inbox faz com o client do usuário
  -- ============================================================
  -- U1 status (dropdown / sweep) numa conversa sem fila e sem responsável
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'waiting_customer' WHERE id = v_c_a_other_queue;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL U1: agent deveria alterar status de conversa da própria account'; END IF;

  -- U2 claim-ao-abrir (status-automation.openPendingConversation)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'in_progress', assigned_agent_id = v_agent_a2
  WHERE id = v_c_a_none AND status = 'pending' AND assigned_agent_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL U2: claim de conversa sem fila deveria funcionar'; END IF;

  -- U3 atribuição manual a um colega da mesma account
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = v_agent_a1 WHERE id = v_c_a_none;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL U3: atribuição manual a colega da mesma account deveria funcionar'; END IF;

  -- U4 queue_id continua bloqueado para authenticated (trigger 076/078)
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET queue_id = v_q2 WHERE id = v_c_a_other_queue;
    RAISE EXCEPTION 'FAIL U4: agent conseguiu alterar queue_id';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS U4: queue_id segue protegido';
  END;
  RESET ROLE;

  -- U5 atribuir a usuário de OUTRA account continua bloqueado (WITH CHECK 076)
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET assigned_agent_id = v_agent_b WHERE id = v_c_a_other_queue;
    RAISE EXCEPTION 'FAIL U5: agent atribuiu conversa a usuário de outra account';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS U5: atribuição cross-account bloqueada';
  END;
  RESET ROLE;

  -- U6 usuário de B / inativo / viewer não escrevem em conversa de A
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'closed' WHERE id = ANY(v_a_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL U6a: usuário de B alterou % conversa(s) de A', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a_inactive)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'closed' WHERE id = ANY(v_a_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL U6b: profile inativo alterou % conversa(s)', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_viewer_a)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'closed' WHERE id = ANY(v_a_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL U6c: viewer alterou % conversa(s)', v_n; END IF;
  RAISE NOTICE 'PASS U1-U6: status/claim/atribuição liberados na própria account; queue_id, cross-account, inativo e viewer continuam bloqueados';

  -- U7 persistência do envio (messages_modify) numa conversa de outra fila
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a2)::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, message_id, status)
  VALUES (v_c_a_other_queue, 'agent', v_agent_a2, 'text', '__082_check__', '__082_check__reply', 'sent');
  UPDATE public.conversations SET last_message_text = '__082_check__', last_message_at = now()
  WHERE id = v_c_a_other_queue;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL U7: prévia pós-envio deveria atualizar'; END IF;

  -- U8 usuário de B não grava mensagem em conversa de A
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_b)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (v_c_a_none, 'agent', 'text', '__082_check__', '__082_check__xacc', 'sent');
    RAISE EXCEPTION 'FAIL U8: usuário de B gravou mensagem em conversa de A';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS U7-U8: envio persiste na própria account; cross-account bloqueado';
  END;
  RESET ROLE;

  RAISE NOTICE '=== 082 validation: TODOS OS CENÁRIOS A-H + U1-U8 PASSARAM ===';
END;
$outer$;

ROLLBACK;
