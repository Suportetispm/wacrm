-- ============================================================
-- 083_inbox_visibility_mode_by_account_check.sql
--
-- Verificação da migration 083 — rodar DEPOIS de aplicar.
--
--   SEÇÃO 1 — estrutural, só catálogo e SELECT. Segura em produção.
--   SEÇÃO 2 — impersonação de usuários REAIS, SOMENTE SELECT, dentro
--             de BEGIN/ROLLBACK. Segura em produção (nada é escrito).
--   SEÇÃO 3 — comportamental com dados sintéticos (INSERT/UPDATE em
--             BEGIN/ROLLBACK). SÓ STAGING — NUNCA PRODUÇÃO (mesma
--             política de todo script de supabase/validation/).
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — estrutural (segura em produção)
-- ============================================================

-- 1.1) CHECK aceita a chave nova
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.conrelid = 'public.account_feature_flags'::regclass AND con.contype = 'c';
-- Esperado: 1 linha, account_feature_flags_feature_key_check, com
-- multi_connection_enabled, business_units_enabled, inbox_account_wide.

-- 1.2) RPC: allowlist com a chave nova; SECURITY DEFINER, search_path,
--      owner e ACL preservados
SELECT
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname   AS owner,
  count(*) OVER () AS total_overloads,
  pg_get_functiondef(p.oid) ILIKE '%''business_units_enabled'', ''inbox_account_wide'']%' AS allowlist_tem_chave_nova,
  pg_get_functiondef(p.oid) ILIKE '%is_platform_admin()%'      AS exige_platform_admin,
  pg_get_functiondef(p.oid) ILIKE '%updated_by = v_caller_id%' AS grava_updated_by,
  pg_get_functiondef(p.oid) ILIKE '%platform_audit_log%'       AS grava_auditoria,
  has_function_privilege('anon', p.oid, 'EXECUTE')             AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')    AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: true, {search_path=public}, postgres, 1, true, true, true,
-- true, false, true.

-- 1.3) Função auxiliar: atributos e ACL
SELECT
  p.oid::regprocedure                    AS signature,
  pg_get_function_result(p.oid)          AS returns,
  p.prosecdef                            AS is_security_definer,
  p.provolatile                          AS volatility,   -- 's' = STABLE
  p.proconfig                            AS config,
  l.lanname                              AS language,
  r.rolname                              AS owner,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = 'is_account_feature_enabled';
-- Esperado: 1 linha — is_account_feature_enabled(uuid,text), boolean,
-- true, 's', {search_path=""}, sql, postgres, false, true, false.

SELECT NOT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  WHERE n.nspname = 'public' AND p.proname = 'is_account_feature_enabled'
    AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
) AS public_has_no_execute;
-- Esperado: true.

-- 1.4) account_feature_flags continua fechada para authenticated/anon
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_feature_flags'::regclass) AS rls_enabled,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'account_feature_flags')                     AS policies,
  has_table_privilege('authenticated', 'public.account_feature_flags', 'SELECT')             AS authenticated_select,
  has_table_privilege('authenticated', 'public.account_feature_flags', 'INSERT')             AS authenticated_insert,
  has_table_privilege('authenticated', 'public.account_feature_flags', 'UPDATE')             AS authenticated_update,
  has_table_privilege('anon', 'public.account_feature_flags', 'SELECT')                      AS anon_select;
-- Esperado: true, 0, false, false, false, false.

-- 1.5) Flag: ARACAGI = true, COHAMA = true, nenhuma outra account
SELECT f.account_id, a.name, f.enabled, f.updated_by, f.updated_at
FROM public.account_feature_flags f
JOIN public.accounts a ON a.id = f.account_id
WHERE f.feature_key = 'inbox_account_wide'
ORDER BY a.name;
-- Esperado: exatamente 2 linhas, ambas enabled = true:
--   3b1cc850-7de0-48df-ba1b-d6334b000c3b  OUTLET - ARACAGI
--   33e1388c-fb0a-457f-ba8e-c01d236897c5  OUTLET - COHAMA

SELECT
  (SELECT count(*) FROM public.account_feature_flags
    WHERE feature_key = 'inbox_account_wide' AND enabled
      AND account_id IN ('3b1cc850-7de0-48df-ba1b-d6334b000c3b',
                         '33e1388c-fb0a-457f-ba8e-c01d236897c5'))     AS alvos_habilitados,
  (SELECT count(*) FROM public.account_feature_flags
    WHERE feature_key = 'inbox_account_wide' AND enabled
      AND account_id NOT IN ('3b1cc850-7de0-48df-ba1b-d6334b000c3b',
                             '33e1388c-fb0a-457f-ba8e-c01d236897c5')) AS outras_accounts_habilitadas;
-- Esperado: 2, 0.

-- 1.6) Modo efetivo por account (ausência de linha = por Setor)
SELECT a.id AS account_id, a.name, a.is_active,
       COALESCE(f.enabled, false) AS inbox_account_wide,
       CASE WHEN COALESCE(f.enabled, false) THEN 'account-wide' ELSE 'por Setor' END AS modo,
       (f.account_id IS NULL) AS sem_linha_de_flag
FROM public.accounts a
LEFT JOIN public.account_feature_flags f
       ON f.account_id = a.id AND f.feature_key = 'inbox_account_wide'
ORDER BY a.name;
-- Esperado: 'account-wide' só nas duas OUTLET; todas as demais
-- 'por Setor' com sem_linha_de_flag = true.

-- 1.7) Policies de conversations
SELECT policyname, cmd, permissive, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: exatamente 3 linhas (nenhuma FOR DELETE — 075).
--   conversations_insert — INALTERADA (is_account_member(account_id,'agent')).
--   conversations_select — is_account_member(account_id) AND
--     (is_account_feature_enabled(account_id,'inbox_account_wide')
--      OR is_account_member(account_id,'admin')
--      OR assigned_agent_id = auth.uid() OR EXISTS queue_members ...).
--   conversations_update — USING is_account_member(account_id,'agent')
--     AND (mesmos 4 ramos); WITH CHECK igual ao da 076/082.

SELECT
  count(*) = 3                                                             AS exatamente_3_policies,
  bool_and(cmd <> 'DELETE')                                                AS sem_policy_de_delete,
  bool_and(COALESCE(btrim(qual, ' ()'), '') <> 'true'
           AND COALESCE(btrim(with_check, ' ()'), '') <> 'true')           AS nenhuma_using_true,
  bool_and(COALESCE(qual, with_check) ILIKE '%is_account_member(account_id%') AS todas_por_account,
  bool_and(COALESCE(qual, '') NOT ILIKE '%queue_id IS NULL%')              AS sem_atalho_queue_null,
  bool_or(policyname = 'conversations_select'
          AND qual ILIKE '%is_account_feature_enabled(account_id, ''inbox_account_wide''%'
          AND qual ILIKE '%queue_members%'
          AND qual ILIKE '%qm.account_id = conversations.account_id%'
          AND qual ILIKE '%qm.is_active%')                                 AS select_hibrida,
  bool_or(policyname = 'conversations_update'
          AND qual ILIKE '%is_account_feature_enabled(account_id, ''inbox_account_wide''%'
          AND qual ILIKE '%queue_members%'
          AND qual ILIKE '%is_account_member(account_id, ''agent''%')      AS update_hibrida,
  bool_or(policyname = 'conversations_update'
          AND with_check ILIKE '%is_account_member(account_id, ''agent''%'
          AND with_check ILIKE '%FROM profiles p%'
          AND with_check ILIKE '%p.account_id = conversations.account_id%'
          AND with_check NOT ILIKE '%queue_members%')                      AS update_with_check_076,
  bool_or(policyname = 'conversations_insert'
          AND cmd = 'INSERT' AND qual IS NULL
          AND with_check NOT ILIKE '%is_account_feature_enabled%'
          AND with_check NOT ILIKE '%queue_members%')                      AS insert_inalterada
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations';
-- Esperado: 9 × true.

-- 1.8) messages — INALTERADAS; seguem a visibilidade da conversation
--      (a subquery em conversations é filtrada pela RLS dela).
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'messages'
ORDER BY policyname;
-- Esperado: messages_select / messages_modify iguais à 017.

-- 1.9) RLS habilitada; triggers 076/078 intactos; Realtime
SELECT relname, relrowsecurity AS rls_enabled
FROM pg_class
WHERE oid IN ('public.conversations'::regclass, 'public.messages'::regclass);
-- Esperado: true / true.

SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: a MESMA lista do preflight P10 — enforce_privilege_columns
-- presente e habilitado ('O').

SELECT pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure)
         ILIKE '%NEW.queue_id IS DISTINCT FROM OLD.queue_id%'           AS protege_queue_id,
       pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure)
         ILIKE '%NEW.whatsapp_config_id IS DISTINCT FROM OLD.whatsapp_config_id%' AS protege_whatsapp_config_id;
-- Esperado: true, true (corpo da 078).

SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('conversations', 'messages');
-- Esperado: 2 linhas.

-- ============================================================
-- SEÇÃO 2 — usuários REAIS, SOMENTE SELECT (segura em produção)
--
-- Substituir <USER_ID> e rodar uma vez para cada perfil:
--   (a) agent de OUTLET - ARACAGI   -> vê todas da ARACAGI, só ela
--   (b) agent de OUTLET - COHAMA    -> vê todas da COHAMA, só ela
--   (c) agent de uma account por Setor -> vê só atribuídas/da fila
--   (d) admin de uma account por Setor -> vê todas da própria account
-- Nada é gravado: só SELECT, e o bloco termina em ROLLBACK.
-- ============================================================

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '<USER_ID>', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- 2a) Função auxiliar como o usuário: própria account e as duas OUTLET
SELECT
  public.is_account_feature_enabled('3b1cc850-7de0-48df-ba1b-d6334b000c3b', 'inbox_account_wide') AS aracagi,
  public.is_account_feature_enabled('33e1388c-fb0a-457f-ba8e-c01d236897c5', 'inbox_account_wide') AS cohama,
  public.is_account_feature_enabled('3b1cc850-7de0-48df-ba1b-d6334b000c3b', 'chave_inexistente')  AS chave_desconhecida,
  public.is_account_feature_enabled(NULL, 'inbox_account_wide')                                   AS account_null;
-- Esperado: true SÓ na coluna da account do próprio usuário, e só se
-- ele for de uma das duas OUTLET; false em todo o resto (membro de
-- outra account nunca descobre a flag alheia). As duas últimas: false.

-- 2b) A tabela continua ilegível diretamente
SELECT count(*) AS linhas_visiveis_direto FROM public.account_feature_flags;
-- Esperado: erro 42501 (permission denied) — authenticated não tem
-- GRANT na tabela. Se preferir não abortar a transação, pule 2b.

-- 2c) Conversas visíveis, por account — SÓ a account do usuário
SELECT c.account_id, count(*) AS visiveis,
       count(*) FILTER (WHERE c.queue_id IS NULL AND c.assigned_agent_id IS NULL) AS sem_fila_sem_responsavel
FROM public.conversations c
GROUP BY c.account_id;

-- 2d) Mensagens visíveis, por account da conversa — mesma account só
SELECT c.account_id, count(m.id) AS mensagens_visiveis
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
GROUP BY c.account_id;

RESET ROLE;

-- 2e) Referência como postgres
SELECT p.account_id, a.name, p.account_role, p.is_active,
       (SELECT count(*) FROM public.conversations c WHERE c.account_id = p.account_id) AS total_da_account,
       (SELECT count(*) FROM public.conversations c
         WHERE c.account_id = p.account_id
           AND (c.assigned_agent_id = p.user_id
                OR EXISTS (SELECT 1 FROM public.queue_members qm
                           WHERE qm.queue_id = c.queue_id AND qm.user_id = p.user_id
                             AND qm.account_id = c.account_id AND qm.is_active))) AS atribuidas_ou_da_fila
FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
WHERE p.user_id = '<USER_ID>';
-- Esperado: 2c tem no máximo 1 linha, account_id = 2e.account_id.
--   OUTLET (qualquer papel) e owner/admin de qualquer account:
--     2c.visiveis = 2e.total_da_account.
--   agent/viewer de account por Setor:
--     2c.visiveis = 2e.atribuidas_ou_da_fila e
--     2c.sem_fila_sem_responsavel = 0.
-- 2d só com essa mesma account_id.
ROLLBACK;

-- ============================================================
-- SEÇÃO 3 — comportamental sintético (SÓ STAGING, BEGIN/ROLLBACK)
--
-- Duas accounts sintéticas: W (flag = true, account-wide) e S (sem
-- flag, por Setor), mais F (flag = false) e X (outra account). Não usa
-- as accounts reais.
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_acc_w UUID := gen_random_uuid(); -- inbox_account_wide = true
  v_acc_s UUID := gen_random_uuid(); -- sem linha de flag
  v_acc_f UUID := gen_random_uuid(); -- inbox_account_wide = false
  v_acc_x UUID := gen_random_uuid(); -- outra account, por Setor

  v_w_owner  UUID := gen_random_uuid();
  v_w_agent  UUID := gen_random_uuid();
  v_w_viewer UUID := gen_random_uuid();

  v_s_owner       UUID := gen_random_uuid();
  v_s_admin       UUID := gen_random_uuid();
  v_s_agent       UUID := gen_random_uuid(); -- membro ATIVO de Q1
  v_s_agent_off   UUID := gen_random_uuid(); -- membro INATIVO de Q1
  v_s_agent_noq   UUID := gen_random_uuid(); -- sem fila
  v_s_viewer      UUID := gen_random_uuid(); -- membro ativo de Q1

  v_f_owner UUID := gen_random_uuid();
  v_f_agent UUID := gen_random_uuid();
  v_x_agent UUID := gen_random_uuid();

  v_q1 UUID := gen_random_uuid();
  v_q2 UUID := gen_random_uuid();

  v_ct_w1 UUID := gen_random_uuid(); v_ct_w2 UUID := gen_random_uuid(); v_ct_w3 UUID := gen_random_uuid();
  v_ct_s1 UUID := gen_random_uuid(); v_ct_s2 UUID := gen_random_uuid(); v_ct_s3 UUID := gen_random_uuid();
  v_ct_s4 UUID := gen_random_uuid(); v_ct_s5 UUID := gen_random_uuid();
  v_ct_f1 UUID := gen_random_uuid(); v_ct_x1 UUID := gen_random_uuid();

  v_c_w_none  UUID := gen_random_uuid(); -- W: sem fila, sem responsável
  v_c_w_other UUID := gen_random_uuid(); -- W: atribuída ao owner
  v_c_w_new   UUID := gen_random_uuid(); -- W: "chega" depois

  v_c_s_none     UUID := gen_random_uuid(); -- S: sem fila, sem responsável
  v_c_s_q1       UUID := gen_random_uuid(); -- S: fila Q1
  v_c_s_q2       UUID := gen_random_uuid(); -- S: fila Q2
  v_c_s_q2_mine  UUID := gen_random_uuid(); -- S: fila Q2, atribuída a s_agent
  v_c_s_new      UUID := gen_random_uuid(); -- S: "chega" depois, sem fila

  v_c_f_none UUID := gen_random_uuid();
  v_c_x_none UUID := gen_random_uuid();

  v_w_convs UUID[];
  v_s_convs UUID[];
  v_n INT;
  v_b BOOLEAN;
BEGIN
  RAISE NOTICE '=== 083 validation: fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         '__083_check__' || u || '@example.com', 'x', now(), now(), now(), '{}', '{}'
  FROM unnest(ARRAY[v_w_owner, v_w_agent, v_w_viewer, v_s_owner, v_s_admin, v_s_agent,
                    v_s_agent_off, v_s_agent_noq, v_s_viewer, v_f_owner, v_f_agent, v_x_agent]) AS u;

  INSERT INTO public.accounts (id, name, owner_user_id, is_active) VALUES
    (v_acc_w, '__083_check__ Account W', v_w_owner, true),
    (v_acc_s, '__083_check__ Account S', v_s_owner, true),
    (v_acc_f, '__083_check__ Account F', v_f_owner, true),
    (v_acc_x, '__083_check__ Account X', v_x_agent, true);

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active) VALUES
    (v_w_owner,     '__083 W Owner',     '__083_check__' || v_w_owner     || '@example.com', v_acc_w, 'owner',  true),
    (v_w_agent,     '__083 W Agent',     '__083_check__' || v_w_agent     || '@example.com', v_acc_w, 'agent',  true),
    (v_w_viewer,    '__083 W Viewer',    '__083_check__' || v_w_viewer    || '@example.com', v_acc_w, 'viewer', true),
    (v_s_owner,     '__083 S Owner',     '__083_check__' || v_s_owner     || '@example.com', v_acc_s, 'owner',  true),
    (v_s_admin,     '__083 S Admin',     '__083_check__' || v_s_admin     || '@example.com', v_acc_s, 'admin',  true),
    (v_s_agent,     '__083 S Agent',     '__083_check__' || v_s_agent     || '@example.com', v_acc_s, 'agent',  true),
    (v_s_agent_off, '__083 S Agent Off', '__083_check__' || v_s_agent_off || '@example.com', v_acc_s, 'agent',  true),
    (v_s_agent_noq, '__083 S Agent NoQ', '__083_check__' || v_s_agent_noq || '@example.com', v_acc_s, 'agent',  true),
    (v_s_viewer,    '__083 S Viewer',    '__083_check__' || v_s_viewer    || '@example.com', v_acc_s, 'viewer', true),
    (v_f_owner,     '__083 F Owner',     '__083_check__' || v_f_owner     || '@example.com', v_acc_f, 'owner',  true),
    (v_f_agent,     '__083 F Agent',     '__083_check__' || v_f_agent     || '@example.com', v_acc_f, 'agent',  true),
    (v_x_agent,     '__083 X Agent',     '__083_check__' || v_x_agent     || '@example.com', v_acc_x, 'owner',  true);

  -- Flags: W = true, F = false, S e X sem linha.
  INSERT INTO public.account_feature_flags (account_id, feature_key, enabled) VALUES
    (v_acc_w, 'inbox_account_wide', true),
    (v_acc_f, 'inbox_account_wide', false);
  RAISE NOTICE 'PASS K1: CHECK aceita inbox_account_wide';

  BEGIN
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_acc_s, '__083_chave_invalida__', true);
    RAISE EXCEPTION 'FAIL K2: CHECK aceitou uma feature_key fora do catálogo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS K2: CHECK rejeita chave fora do catálogo';
  END;

  INSERT INTO public.queues (id, account_id, name, is_active) VALUES
    (v_q1, v_acc_s, '__083_check__ Q1', true),
    (v_q2, v_acc_s, '__083_check__ Q2', true);
  INSERT INTO public.queue_members (account_id, queue_id, user_id, is_active) VALUES
    (v_acc_s, v_q1, v_s_agent,     true),
    (v_acc_s, v_q1, v_s_viewer,    true),
    (v_acc_s, v_q1, v_s_agent_off, false);

  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
    (v_ct_w1, v_w_owner, v_acc_w, '+5598900083001', '__083 W1'),
    (v_ct_w2, v_w_owner, v_acc_w, '+5598900083002', '__083 W2'),
    (v_ct_w3, v_w_owner, v_acc_w, '+5598900083003', '__083 W3'),
    (v_ct_s1, v_s_owner, v_acc_s, '+5598900083004', '__083 S1'),
    (v_ct_s2, v_s_owner, v_acc_s, '+5598900083005', '__083 S2'),
    (v_ct_s3, v_s_owner, v_acc_s, '+5598900083006', '__083 S3'),
    (v_ct_s4, v_s_owner, v_acc_s, '+5598900083007', '__083 S4'),
    (v_ct_s5, v_s_owner, v_acc_s, '+5598900083008', '__083 S5'),
    (v_ct_f1, v_f_owner, v_acc_f, '+5598900083009', '__083 F1'),
    (v_ct_x1, v_x_agent, v_acc_x, '+5598900083010', '__083 X1');

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id) VALUES
    (v_c_w_none,    v_w_owner, v_acc_w, v_ct_w1, 'pending',     NULL, NULL),
    (v_c_w_other,   v_w_owner, v_acc_w, v_ct_w2, 'in_progress', NULL, v_w_owner),
    (v_c_s_none,    v_s_owner, v_acc_s, v_ct_s1, 'pending',     NULL, NULL),
    (v_c_s_q1,      v_s_owner, v_acc_s, v_ct_s2, 'pending',     v_q1, NULL),
    (v_c_s_q2,      v_s_owner, v_acc_s, v_ct_s3, 'pending',     v_q2, NULL),
    (v_c_s_q2_mine, v_s_owner, v_acc_s, v_ct_s4, 'in_progress', v_q2, v_s_agent),
    (v_c_f_none,    v_f_owner, v_acc_f, v_ct_f1, 'pending',     NULL, NULL),
    (v_c_x_none,    v_x_agent, v_acc_x, v_ct_x1, 'pending',     NULL, NULL);

  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
  SELECT c, 'customer', 'text', '__083_check__', '__083_check__' || c, 'delivered'
  FROM unnest(ARRAY[v_c_w_none, v_c_w_other, v_c_s_none, v_c_s_q1, v_c_s_q2, v_c_s_q2_mine,
                    v_c_f_none, v_c_x_none]) AS c;

  v_w_convs := ARRAY[v_c_w_none, v_c_w_other];
  v_s_convs := ARRAY[v_c_s_none, v_c_s_q1, v_c_s_q2, v_c_s_q2_mine];

  -- ============================================================
  -- K) Função auxiliar — true/false, ausência, cross-account
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w_agent)::text, true);
  SET LOCAL ROLE authenticated;
  v_b := public.is_account_feature_enabled(v_acc_w, 'inbox_account_wide');
  IF v_b IS NOT TRUE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K3: flag true deveria devolver true ao membro'; END IF;
  v_b := public.is_account_feature_enabled(v_acc_w, 'multi_connection_enabled');
  IF v_b IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K4: outra chave sem linha deveria ser false'; END IF;
  v_b := public.is_account_feature_enabled(v_acc_w, '__083_chave_invalida__');
  IF v_b IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K5: chave desconhecida deveria ser false'; END IF;
  v_b := public.is_account_feature_enabled(NULL, 'inbox_account_wide');
  IF v_b IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K6: account NULL deveria ser false (nunca NULL)'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
  SET LOCAL ROLE authenticated;
  v_b := public.is_account_feature_enabled(v_acc_s, 'inbox_account_wide');
  IF v_b IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K7: ausência de flag deveria ser false'; END IF;
  v_b := public.is_account_feature_enabled(v_acc_w, 'inbox_account_wide');
  IF v_b IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL K8: não-membro descobriu a flag de outra account'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_agent)::text, true);
  SET LOCAL ROLE authenticated;
  v_b := public.is_account_feature_enabled(v_acc_f, 'inbox_account_wide');
  RESET ROLE;
  IF v_b IS NOT FALSE THEN RAISE EXCEPTION 'FAIL K9: enabled = false deveria ser false'; END IF;

  -- authenticated não lê nem escreve a tabela diretamente
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w_agent)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.account_feature_flags LIMIT 1;
    RAISE EXCEPTION 'FAIL K10: authenticated leu account_feature_flags diretamente';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_acc_s, 'inbox_account_wide', true);
    RAISE EXCEPTION 'FAIL K11: authenticated gravou a própria flag';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  -- RPC: aceita a chave nova na allowlist, mas só para platform admin
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_owner)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.platform_set_account_feature(v_acc_s, 'inbox_account_wide', true);
    RAISE EXCEPTION 'FAIL K12: owner comum ligou a flag via RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  RAISE NOTICE 'PASS K3-K12: função auxiliar true/false/ausente/cross-account; tabela e RPC fechadas para usuário comum';

  -- ============================================================
  -- W) Account-wide (flag = true)
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_w_convs);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL W1: agent de W deveria ver 2 conversas, viu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.conversations
  WHERE id = ANY(v_s_convs || ARRAY[v_c_f_none, v_c_x_none]);
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL W2: agent de W viu % conversa(s) de outra account', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id = ANY(v_w_convs);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL W3: agent de W deveria ler 2 mensagens, leu %', v_n; END IF;
  UPDATE public.conversations SET status = 'in_progress', assigned_agent_id = v_w_agent
  WHERE id = v_c_w_none AND status = 'pending' AND assigned_agent_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL W4: claim de conversa sem fila deveria funcionar em account-wide'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w_viewer)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_w_convs);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL W5: viewer de W deveria ver 2, viu %', v_n; END IF;
  UPDATE public.conversations SET status = 'closed' WHERE id = ANY(v_w_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL W6: viewer de W alterou % conversa(s)', v_n; END IF;
  RAISE NOTICE 'PASS W1-W6: account-wide vê/opera tudo da própria account, nada de fora; viewer só lê';

  -- ============================================================
  -- S) Por Setor (sem flag)
  -- ============================================================
  -- S1 owner/admin veem tudo da própria account
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_owner)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_s_convs || v_w_convs);
  RESET ROLE;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL S1a: owner de S deveria ver 4 (só S), viu %', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_admin)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_s_convs || v_w_convs);
  RESET ROLE;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL S1b: admin de S deveria ver 4 (só S), viu %', v_n; END IF;

  -- S2 agent: fila Q1 + atribuída a ele (Q2); NÃO vê Q2 alheia nem sem fila
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id IN (v_c_s_q1, v_c_s_q2_mine);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S2a: agent deveria ver a da fila e a atribuída, viu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id IN (v_c_s_q2, v_c_s_none);
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S2b: agent viu % conversa(s) de outra fila / sem fila', v_n; END IF;
  -- messages acompanham a conversation
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id = ANY(v_s_convs);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S2c: agent deveria ler 2 mensagens (só das conversas visíveis), leu %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.messages WHERE conversation_id IN (v_c_s_q2, v_c_s_none);
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S2d: agent leu % mensagem(ns) de conversa invisível', v_n; END IF;
  RESET ROLE;

  -- S3 membro INATIVO da fila e agent sem fila não veem nada
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent_off)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_s_convs);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL S3a: membro inativo da fila viu % conversa(s)', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent_noq)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_s_convs);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL S3b: agent sem fila viu % conversa(s)', v_n; END IF;

  -- S4 viewer: mesma restrição de SELECT, zero escrita
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_viewer)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_s_convs);
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S4a: viewer deveria ver só a conversa de Q1, viu %', v_n; END IF;
  UPDATE public.conversations SET status = 'closed' WHERE id = ANY(v_s_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL S4b: viewer alterou % conversa(s)', v_n; END IF;

  -- S5 agent não atualiza conversa de outro setor / sem fila; atualiza as suas
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'closed' WHERE id IN (v_c_s_q2, v_c_s_none);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S5a: agent alterou % conversa(s) fora do seu setor', v_n; END IF;
  UPDATE public.conversations SET status = 'in_progress', assigned_agent_id = v_s_agent
  WHERE id = v_c_s_q1 AND status = 'pending' AND assigned_agent_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL S5b: claim na própria fila deveria funcionar'; END IF;
  -- reatribuir a colega da mesma account (WITH CHECK não reexige fila/responsável)
  UPDATE public.conversations SET assigned_agent_id = v_s_agent_noq WHERE id = v_c_s_q2_mine;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL S5c: reatribuição a colega da mesma account deveria funcionar'; END IF;

  -- S6 queue_id protegido (trigger 076/078) e atribuição cross-account bloqueada (WITH CHECK)
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET queue_id = v_q2 WHERE id = v_c_s_q1;
    RAISE EXCEPTION 'FAIL S6a: agent conseguiu alterar queue_id';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET assigned_agent_id = v_x_agent WHERE id = v_c_s_q1;
    RAISE EXCEPTION 'FAIL S6b: agent atribuiu conversa a usuário de outra account';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  RAISE NOTICE 'PASS S1-S6: por Setor — admin vê tudo; agent/viewer só responsável ou fila ativa; sem fila invisível; escrita restrita';

  -- ============================================================
  -- F) enabled = false se comporta como ausência
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_f_none;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL F1: flag false deveria manter a account por Setor'; END IF;

  -- ligar a flag (como service_role/postgres) torna a mesma account account-wide
  UPDATE public.account_feature_flags SET enabled = true
  WHERE account_id = v_acc_f AND feature_key = 'inbox_account_wide';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_f_none;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL F2: flag true deveria tornar a account account-wide'; END IF;
  RAISE NOTICE 'PASS F1-F2: false = por Setor; true = account-wide';

  -- ============================================================
  -- X) Cross-account em todas as direções
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations
  WHERE id = ANY(v_w_convs || v_s_convs || ARRAY[v_c_f_none]);
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL X1: usuário de X viu % conversa(s) de outras accounts', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.messages
  WHERE conversation_id = ANY(v_w_convs || v_s_convs || ARRAY[v_c_f_none]);
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL X2: usuário de X leu % mensagem(ns) de outras accounts', v_n; END IF;
  UPDATE public.conversations SET status = 'closed'
  WHERE id = ANY(v_w_convs || v_s_convs || ARRAY[v_c_f_none]);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL X3: usuário de X alterou % conversa(s) de outras accounts', v_n; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_owner)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = ANY(v_w_convs || ARRAY[v_c_x_none]);
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL X4: owner de S viu % conversa(s) de outras accounts', v_n; END IF;
  RAISE NOTICE 'PASS X1-X4: isolamento cross-account preservado nos dois modos';

  -- ============================================================
  -- R) O que o Realtime (postgres_changes) autoriza por assinante
  -- ============================================================
  -- conversa nova chega sem fila (webhook, service_role/postgres)
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status)
  VALUES (v_c_w_new, v_w_owner, v_acc_w, v_ct_w3, 'pending'),
         (v_c_s_new, v_s_owner, v_acc_s, v_ct_s5, 'pending');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_w_new;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL R1: account-wide deveria enxergar a conversa nova na hora'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_s_new;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL R2: por Setor não deveria enxergar a conversa nova ainda sem fila'; END IF;

  -- Flow roteia (service_role/postgres grava queue_id) -> passa a ser visível
  UPDATE public.conversations SET queue_id = v_q1 WHERE id = v_c_s_new;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_agent)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.conversations WHERE id = v_c_s_new;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL R3: conversa roteada para Q1 deveria aparecer ao membro de Q1'; END IF;
  RAISE NOTICE 'PASS R1-R3: account-wide recebe o INSERT; por Setor só após o Flow gravar queue_id';

  RAISE NOTICE '=== 083 validation: TODOS OS CENÁRIOS K / W / S / F / X / R PASSARAM ===';
END;
$outer$;

ROLLBACK;
