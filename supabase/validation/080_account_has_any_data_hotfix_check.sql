-- ============================================================
-- 080_account_has_any_data_hotfix_check.sql
--
-- Verificação da migration 080_account_has_any_data_account_members_hotfix.
--
--   SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA. Selecione até o marcador
--             "FIM DA SEÇÃO 1". Compare os [SNAPSHOT] com o preflight.
--   SEÇÃO 2 — STAGING APENAS. BEGIN/ROLLBACK, dados sintéticos
--             '__080_check__'. NUNCA EXECUTAR EM PRODUÇÃO.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA
-- ============================================================

-- 1/2/3/4/5. Existe; assinatura, retorno, security, volatility,
-- search_path, owner e ACL inalterados
SELECT
  pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_function_result(p.oid)             AS result,
  l.lanname                                 AS language,
  p.prosecdef                               AS security_definer,
  p.provolatile                             AS volatility,
  p.proconfig                               AS config,
  r.rolname                                 AS owner,
  array_to_string(p.proacl, ', ')           AS acl
FROM pg_proc p
JOIN pg_roles r ON r.oid = p.proowner
JOIN pg_language l ON l.oid = p.prolang
WHERE p.oid = 'public.account_has_any_data(uuid)'::regprocedure;
-- Esperado: IDÊNTICO ao preflight — p_account_id uuid / boolean /
-- plpgsql / true / s / {search_path=public} / postgres / mesma ACL
-- (só postgres).

SELECT count(*) AS account_has_any_data_overloads
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'account_has_any_data';
-- Esperado: 1 (nenhuma sobrecarga nova criada por engano).

SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'account_has_any_data'
ORDER BY grantee;
-- Esperado: apenas postgres.

-- 6/7. account_members passou a ser ignorada; demais exclusões iguais
SELECT
  pg_get_functiondef(p.oid) ILIKE '%''account_members''%'          AS excludes_account_members,
  pg_get_functiondef(p.oid) ILIKE '%<> ''profiles''%'              AS excludes_profiles,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_types''%'    AS excl_types,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_statuses''%' AS excl_statuses,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_stages''%'   AS excl_stages,
  pg_get_functiondef(p.oid) ILIKE '%''internal_teams''%'           AS excl_teams,
  md5(p.prosrc) AS prosrc_md5
FROM pg_proc p
WHERE p.oid = 'public.account_has_any_data(uuid)'::regprocedure;
-- Esperado: true / true / true / true / true / true.
-- prosrc_md5 DIFERENTE do preflight (a função mudou).

-- Lista efetiva de tabelas varridas agora (mesmo filtro da função)
SELECT c.table_name
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
  AND t.table_type = 'BASE TABLE'
  AND c.table_name <> 'profiles'
  AND c.table_name NOT IN ('internal_ticket_types', 'internal_ticket_statuses',
                           'internal_ticket_stages', 'internal_teams', 'account_members')
ORDER BY c.table_name;
-- Esperado: lista do preflight MENOS account_members (nº de linhas =
-- preflight − 1). contacts, conversations, whatsapp_config, deals,
-- internal_companies, queue_members etc. continuam presentes.

-- Efeito por account (só leitura — a função é STABLE e só faz SELECT)
SELECT
  count(*)                                                       AS accounts_total,
  count(*) FILTER (WHERE public.account_has_any_data(a.id))      AS accounts_with_data_now,
  count(*) FILTER (WHERE NOT public.account_has_any_data(a.id))  AS accounts_without_data_now
FROM public.accounts a;
-- Esperado: accounts_with_data_now ≤ preflight. Toda account que
-- passou para false deve aparecer abaixo e NÃO ter dado operacional.

SELECT a.id, a.name, a.owner_user_id, a.created_at,
       (SELECT count(*) FROM public.profiles p WHERE p.account_id = a.id)        AS profiles,
       (SELECT count(*) FROM public.account_members m WHERE m.account_id = a.id) AS memberships
FROM public.accounts a
WHERE NOT public.account_has_any_data(a.id)
ORDER BY a.created_at DESC;
-- Esperado: só accounts "vazias" (em geral nenhuma, ou accounts pessoais
-- sem uso). Uma account de cliente real aqui = PARAR e investigar.

-- 8. Nenhum outro objeto alterado — comparar com o [SNAPSHOT] do preflight
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS prosrc_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosrc ILIKE '%account_has_any_data%'
  AND p.proname <> 'account_has_any_data'
ORDER BY p.proname;
-- Esperado: as mesmas 3 linhas e os MESMOS md5 do preflight
-- (create_account_member, platform_attach_user_to_account,
-- platform_create_account).

SELECT
  (SELECT md5(string_agg(column_name || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, ''),
                         ',' ORDER BY ordinal_position))
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account_members')        AS account_members_columns_md5,
  (SELECT count(*) FROM public.account_members)                              AS account_members_rows,
  (SELECT count(*) FROM public.profiles)                                     AS profiles_rows,
  (SELECT count(*) FROM public.accounts)                                     AS accounts_rows,
  (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.account_members_sync_from_profile()'::regprocedure)  AS sync_fn_md5,
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'sync_account_members'
      AND tgenabled = 'O')                                                   AS sync_trigger_enabled,
  (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.is_account_member(uuid, public.account_role_enum)'::regprocedure) AS is_account_member_md5,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')             AS policies_total,
  (SELECT md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''),
                         ',' ORDER BY tablename, policyname))
     FROM pg_policies WHERE schemaname = 'public')                           AS policies_md5;
-- Esperado: IDÊNTICO ao preflight. Contagens de linhas só podem
-- divergir por cadastro legítimo entre preflight e check (a 080 não
-- escreve em tabela nenhuma). sync_trigger_enabled = 1.

-- Integridade MU-1 continua 1:1
SELECT
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = p.user_id AND m.account_id = p.account_id)) AS profiles_without_membership,
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.user_id = m.user_id AND p.account_id = m.account_id)) AS memberships_without_profile;
-- Esperado: 0 / 0.

-- ============================================================
-- FIM DA SEÇÃO 1
-- ============================================================


-- ============================================================
-- SEÇÃO 2 — STAGING APENAS. NUNCA EXECUTAR EM PRODUÇÃO.
--
-- BEGIN/ROLLBACK. Fixtures criados pelo caminho real: INSERT em
-- auth.users → handle_new_user (017) cria account temporária + profile
-- → sync_account_members (079) cria a membership. Nada disso é
-- inserido à mão (lição da 077).
--
-- Usuários:
--   v_owner  — owner da account de destino A (a account pessoal dele)
--   v_padmin — Superadmin (linha em platform_admins, só nesta transação)
--   v_probe  — CASO A/B (account temporária pura, depois com dado real)
--   v_new_c  — CASO C (create_account_member)
--   v_new_d  — CASO D (platform_attach_user_to_account)
--   v_new_e  — CASO E (platform_create_account, caminho de conversão)
--   v_new_f  — CASO F (controle negativo: dado real continua bloqueando)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_owner   UUID := gen_random_uuid();
  v_padmin  UUID := gen_random_uuid();
  v_probe   UUID := gen_random_uuid();
  v_new_c   UUID := gen_random_uuid();
  v_new_d   UUID := gen_random_uuid();
  v_new_e   UUID := gen_random_uuid();
  v_new_f   UUID := gen_random_uuid();
  v_acc_a   UUID;
  v_tmp     UUID;
  v_ret     UUID;
  v_acc     UUID;
  v_role    TEXT;
  v_tbl     RECORD;
  v_found   BOOLEAN;
  v_hits    TEXT := '';
BEGIN
  RAISE NOTICE '=== 080 validation: fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  SELECT u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         '__080_check__' || u.tag || '@example.com', 'x', now(), now(), now(), '{}',
         json_build_object('full_name', '__080_check__ ' || u.tag)::jsonb
  FROM (VALUES (v_owner, 'owner'), (v_padmin, 'padmin'), (v_probe, 'probe'),
               (v_new_c, 'c'), (v_new_d, 'd'), (v_new_e, 'e'), (v_new_f, 'f')) AS u(id, tag);

  SELECT account_id INTO v_acc_a FROM public.profiles WHERE user_id = v_owner;
  IF v_acc_a IS NULL
     OR (SELECT count(*) FROM public.profiles
          WHERE user_id IN (v_owner, v_padmin, v_probe, v_new_c, v_new_d, v_new_e, v_new_f)) <> 7 THEN
    RAISE EXCEPTION 'FAIL 0: handle_new_user não criou account/profile para os fixtures';
  END IF;

  INSERT INTO public.platform_admins (user_id) VALUES (v_padmin);

  -- ----------------------------------------------------------
  -- CASO A: account temporária só com account + profile + membership
  -- (+ seeds da 052) → false
  -- ----------------------------------------------------------
  SELECT account_id INTO v_tmp FROM public.profiles WHERE user_id = v_probe;
  IF NOT EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_probe AND account_id = v_tmp) THEN
    RAISE EXCEPTION 'FAIL A0: pré-condição — trigger da 079 deveria ter criado a membership da account temporária';
  END IF;
  IF public.account_has_any_data(v_tmp) THEN
    -- Diagnóstico: quais tabelas varridas têm linha dessa account
    FOR v_tbl IN
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
        AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT IN ('profiles', 'internal_ticket_types', 'internal_ticket_statuses',
                                 'internal_ticket_stages', 'internal_teams', 'account_members')
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE account_id = $1)', v_tbl.table_name)
        INTO v_found USING v_tmp;
      IF v_found THEN v_hits := v_hits || v_tbl.table_name || ' '; END IF;
    END LOOP;
    RAISE EXCEPTION 'FAIL A: account temporária pura deveria dar false (tabelas com linha: %)',
      coalesce(nullif(v_hits, ''), '<nenhuma além das excluídas — a 080 não foi aplicada?>');
  END IF;
  RAISE NOTICE 'PASS A: account + profile + account_members (+ seeds) → account_has_any_data = false';

  -- ----------------------------------------------------------
  -- CASO B: mesma account + dado operacional real → true
  -- (internal_companies: dado real sem seed, citado pela 055)
  -- ----------------------------------------------------------
  INSERT INTO public.internal_companies (account_id, name) VALUES (v_tmp, '__080_check__ company');
  IF NOT public.account_has_any_data(v_tmp) THEN
    RAISE EXCEPTION 'FAIL B: account com dado operacional real deveria dar true';
  END IF;
  RAISE NOTICE 'PASS B: dado operacional real continua contando → true';

  -- ----------------------------------------------------------
  -- CASO C: create_account_member (owner de A anexa v_new_c)
  -- ----------------------------------------------------------
  SELECT account_id INTO v_tmp FROM public.profiles WHERE user_id = v_new_c;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.create_account_member(v_new_c, 'agent', '__080_check__ C', NULL);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL C: create_account_member falhou (% / %)', SQLSTATE, SQLERRM;
  END;
  SELECT account_id, account_role::text INTO v_acc, v_role FROM public.profiles WHERE user_id = v_new_c;
  IF v_acc IS DISTINCT FROM v_acc_a OR v_role IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'FAIL C2: profile deveria estar em A como agent (account=%, role=%)', v_acc, v_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_new_c AND account_id = v_acc_a AND role = 'agent')
     OR EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_new_c AND account_id = v_tmp)
     OR EXISTS (SELECT 1 FROM public.accounts WHERE id = v_tmp) THEN
    RAISE EXCEPTION 'FAIL C3: membership não refletiu o move ou account temporária não foi apagada';
  END IF;
  RAISE NOTICE 'PASS C: create_account_member anexa usuário novo (membership movida, account temporária apagada)';

  -- ----------------------------------------------------------
  -- CASO D: platform_attach_user_to_account (Superadmin anexa v_new_d em A)
  -- ----------------------------------------------------------
  SELECT account_id INTO v_tmp FROM public.profiles WHERE user_id = v_new_d;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_padmin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_padmin::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.platform_attach_user_to_account(v_new_d, v_acc_a, 'agent', '__080_check__ D', NULL);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL D: platform_attach_user_to_account falhou (% / %)', SQLSTATE, SQLERRM;
  END;
  IF (SELECT account_id FROM public.profiles WHERE user_id = v_new_d) IS DISTINCT FROM v_acc_a
     OR NOT EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_new_d AND account_id = v_acc_a)
     OR EXISTS (SELECT 1 FROM public.accounts WHERE id = v_tmp) THEN
    RAISE EXCEPTION 'FAIL D2: attach não moveu profile/membership ou não apagou a account temporária';
  END IF;
  RAISE NOTICE 'PASS D: platform_attach_user_to_account anexa usuário novo';

  -- ----------------------------------------------------------
  -- CASO E: platform_create_account, caminho de conversão (reaproveita
  -- a account pessoal vazia de v_new_e como empresa nova)
  -- ----------------------------------------------------------
  SELECT account_id INTO v_tmp FROM public.profiles WHERE user_id = v_new_e;
  BEGIN
    SET LOCAL ROLE authenticated;   -- claims ainda do Superadmin (CASO D)
    v_ret := public.platform_create_account('__080_check__ Empresa E', v_new_e);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL E: platform_create_account falhou (% / %)', SQLSTATE, SQLERRM;
  END;
  IF v_ret IS DISTINCT FROM v_tmp THEN
    RAISE EXCEPTION 'FAIL E2: conversão deveria reaproveitar a account % (retornou %)', v_tmp, v_ret;
  END IF;
  RAISE NOTICE 'PASS E: platform_create_account converte account pessoal vazia';

  -- ----------------------------------------------------------
  -- CASO F (controle negativo): account temporária COM dado real
  -- continua bloqueando create_account_member com 23505
  -- ----------------------------------------------------------
  SELECT account_id INTO v_tmp FROM public.profiles WHERE user_id = v_new_f;
  INSERT INTO public.internal_companies (account_id, name) VALUES (v_tmp, '__080_check__ company F');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.create_account_member(v_new_f, 'agent', '__080_check__ F', NULL);
    RESET ROLE;
    RAISE EXCEPTION 'FAIL F: create_account_member deveria recusar account com dado operacional'
      USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM NOT ILIKE '%operational data%' THEN
        RAISE EXCEPTION 'FAIL F2: 23505 por outro motivo: %', SQLERRM;
      END IF;
  END;
  IF (SELECT account_id FROM public.profiles WHERE user_id = v_new_f) IS DISTINCT FROM v_tmp THEN
    RAISE EXCEPTION 'FAIL F3: profile não deveria ter sido movido';
  END IF;
  RAISE NOTICE 'PASS F: dado operacional real continua bloqueando o attach (23505)';

  RAISE NOTICE '=== 080 validation: TODOS OS TESTES PASSARAM ===';
END;
$outer$;

ROLLBACK;
