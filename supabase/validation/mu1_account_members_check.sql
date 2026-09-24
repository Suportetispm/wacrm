-- ============================================================
-- mu1_account_members_check.sql
--
-- Verificação da migration 079_account_members.sql (ETAPA MU-1).
--
--   SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA. Selecione até o marcador
--             "FIM DA SEÇÃO 1".
--   SEÇÃO 2 — STAGING APENAS. BEGIN/ROLLBACK, dados sintéticos
--             '__mu1_check__'. NUNCA EXECUTAR EM PRODUÇÃO.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA
-- ============================================================

-- 1/2/3. Tabela existe, RLS ativa, PK correta
SELECT to_regclass('public.account_members') AS table_exists,
       (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.account_members')) AS rls_enabled;
-- Esperado: public.account_members / true.

SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'account_members'
ORDER BY ordinal_position;
-- Esperado: id uuid NOT NULL gen_random_uuid(); user_id uuid NOT NULL;
-- account_id uuid NOT NULL; role account_role_enum NOT NULL;
-- is_active boolean NOT NULL default true; invited_by uuid NULL;
-- created_at / updated_at timestamptz NOT NULL default now().

-- 3-7. Constraints (PK, UNIQUE, FKs)
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.account_members'::regclass
ORDER BY contype, conname;
-- Esperado:
--   account_members_pkey                   PRIMARY KEY (id)
--   account_members_user_id_account_id_key UNIQUE (user_id, account_id)
--   FK (user_id)    REFERENCES auth.users(id)       ON DELETE CASCADE
--   FK (account_id) REFERENCES accounts(id)         ON DELETE CASCADE
--   FK (invited_by) REFERENCES auth.users(id)       ON DELETE SET NULL

-- Índices
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'account_members'
ORDER BY indexname;
-- Esperado: account_members_pkey, account_members_user_id_account_id_key,
-- idx_account_members_account (account_id). Nada além.

-- RLS: policies (só SELECT) e grants (authenticated só SELECT)
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'account_members'
ORDER BY policyname;
-- Esperado: account_members_select_account_admin (SELECT,
-- is_account_member(account_id, 'admin')) e account_members_select_own
-- (SELECT, user_id = auth.uid()). NENHUMA policy INSERT/UPDATE/DELETE/ALL.

SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'account_members'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
GROUP BY grantee ORDER BY grantee;
-- Esperado: authenticated = SELECT. anon/PUBLIC ausentes.

-- 8. Quantidade de memberships
SELECT count(*) AS memberships, (SELECT count(*) FROM public.profiles) AS profiles
FROM public.account_members;
-- Esperado: memberships = profiles (21 no estado do MU-0).

-- 9-12. Correspondência exata profile ↔ membership
SELECT
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = p.user_id AND m.account_id = p.account_id))       AS profiles_without_membership,
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.user_id = m.user_id AND p.account_id = m.account_id))       AS memberships_without_profile,
  (SELECT count(*) FROM public.account_members m JOIN public.profiles p
      ON p.user_id = m.user_id AND p.account_id = m.account_id
    WHERE m.role IS DISTINCT FROM p.account_role)                                         AS role_mismatch,
  (SELECT count(*) FROM public.account_members m JOIN public.profiles p
      ON p.user_id = m.user_id AND p.account_id = m.account_id
    WHERE m.is_active IS DISTINCT FROM p.is_active)                                       AS is_active_mismatch,
  (SELECT count(*) FROM (SELECT user_id FROM public.account_members
                         GROUP BY user_id HAVING count(*) > 1) d)                         AS users_with_more_than_one_membership;
-- Esperado: 0 / 0 / 0 / 0 / 0. (MU-1 ainda é 1:1 — uma membership por
-- usuário. >1 aqui = algo escreveu em account_members por fora.)

-- 13-15. Integridade
SELECT
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id))     AS without_auth_user,
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = m.account_id)) AS without_account,
  (SELECT count(*) - count(DISTINCT (user_id, account_id)) FROM public.account_members) AS duplicates,
  (SELECT count(*) FROM public.account_members WHERE invited_by IS NOT NULL)  AS with_invited_by;
-- Esperado: 0 / 0 / 0 / 0 (backfill não preenche invited_by).

-- 16/17. profiles e accounts inalterados — mesmos hashes do bloco 14 do
-- preflight
SELECT
  (SELECT count(*) FROM public.profiles) AS profiles_count,
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || account_role::text || ':' || is_active::text,
                         ',' ORDER BY user_id))
     FROM public.profiles)                                  AS profiles_membership_hash,
  (SELECT md5(string_agg(id::text || ':' || owner_user_id::text || ':' || is_active::text, ',' ORDER BY id))
     FROM public.accounts)                                  AS accounts_owner_hash,
  (SELECT max(updated_at) FROM public.profiles)             AS profiles_max_updated_at;
-- Esperado: IDÊNTICO ao snapshot do preflight (a migration não escreve
-- em profiles nem em accounts). Divergência só é aceitável se houve
-- cadastro/alteração legítima de membro entre o preflight e o check — e
-- nesse caso os blocos 9-12 devem continuar 0.

-- Owners continuam coerentes, e a membership do owner é 'owner'
SELECT
  (SELECT count(*) FROM public.accounts a
     LEFT JOIN public.profiles p ON p.user_id = a.owner_user_id
    WHERE p.user_id IS NULL OR p.account_id <> a.id OR p.account_role::text <> 'owner') AS owner_inconsistent_profiles,
  (SELECT count(*) FROM public.accounts a
     LEFT JOIN public.account_members m ON m.user_id = a.owner_user_id AND m.account_id = a.id
    WHERE m.id IS NULL OR m.role::text <> 'owner')                                     AS owner_without_owner_membership;
-- Esperado: 0 / 0.

-- 18/19. FKs para profiles inalteradas (3 de membership + deals)
SELECT c.conrelid::regclass AS source_table, c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
ORDER BY 1, 2;
-- Esperado: 4 linhas, iguais ao MU-0:
--   deals_assigned_to_fkey                               (assigned_to) → profiles(id) ON DELETE SET NULL
--   internal_team_members_user_id_account_id_fkey        (user_id, account_id) → profiles(user_id, account_id)
--   queue_members_user_id_account_id_fkey                idem
--   user_permission_overrides_user_id_account_id_fkey    idem
-- NENHUMA FK aponta para account_members ainda:
SELECT count(*) AS fks_to_account_members
FROM pg_constraint WHERE contype = 'f' AND confrelid = to_regclass('public.account_members');
-- Esperado: 0.

-- 20. Nenhuma business_unit criada
SELECT to_regclass('public.business_units') AS business_units,
       to_regclass('public.user_business_units') AS user_business_units,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'business_unit_id') AS business_unit_id_columns;
-- Esperado: NULL / NULL / 0.

-- 21. Policies existentes intactas
SELECT
  count(*) FILTER (WHERE tablename <> 'account_members'
                   AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%is_account_member%') AS other_policies_using_is_account_member,
  count(*) FILTER (WHERE tablename <> 'account_members'
                   AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%profiles%')          AS other_policies_reading_profiles,
  count(*) FILTER (WHERE tablename <> 'account_members')                                           AS other_policies_total,
  count(*) FILTER (WHERE tablename = 'account_members')                                            AS account_members_policies,
  count(*) FILTER (WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%account_members%') AS policies_referencing_account_members
FROM pg_policies WHERE schemaname = 'public';
-- Esperado: 130 / 1 / (= total anotado no preflight) / 2 / 0.
-- policies_referencing_account_members = 0: nenhuma policy existente
-- passou a depender da tabela nova.

-- is_account_member inalterada (ainda lê profiles, não account_members)
SELECT pg_get_functiondef('public.is_account_member(uuid, public.account_role_enum)'::regprocedure)
         ILIKE '%account_members%' AS is_account_member_reads_account_members,
       pg_get_functiondef('public.is_account_member(uuid, public.account_role_enum)'::regprocedure)
         ILIKE '%FROM profiles%' AS is_account_member_reads_profiles;
-- Esperado: false / true.

-- 22. Runtime ainda usa profiles — nenhuma função existente lê
-- account_members, exceto o trigger de sync
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosrc ILIKE '%account_members%'
ORDER BY p.proname;
-- Esperado: 1 linha — account_members_sync_from_profile.

-- Trigger de sync presente e função trancada
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'sync_account_members';
-- Esperado: AFTER INSERT OR DELETE OR UPDATE OF user_id, account_id,
-- account_role, is_active ON profiles ... account_members_sync_from_profile().

SELECT p.prosecdef AS security_definer, array_to_string(p.proacl, ', ') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'account_members_sync_from_profile';
-- Esperado: true; ACL sem EXECUTE para PUBLIC/anon/authenticated/service_role.

-- ============================================================
-- FIM DA SEÇÃO 1
-- ============================================================


-- ============================================================
-- SEÇÃO 2 — STAGING APENAS. NUNCA EXECUTAR EM PRODUÇÃO.
--
-- BEGIN/ROLLBACK. Fixture respeita handle_new_user (017): a account e o
-- profile são criados pelo trigger de auth.users e LIDOS depois — nunca
-- inseridos à mão (lição da 077).
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_a        UUID := gen_random_uuid();   -- owner de A
  v_b        UUID := gen_random_uuid();   -- owner de B
  v_agent    UUID := gen_random_uuid();   -- membro que vai ser movido
  v_acc_a    UUID;
  v_acc_b    UUID;
  v_acc_tmp  UUID;
  v_count    INTEGER;
  v_before   INTEGER;
  v_role     TEXT;
  v_active   BOOLEAN;
  v_ctid     TEXT;
BEGIN
  RAISE NOTICE '=== MU-1 validation: fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_a,     '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__mu1_check__a@example.com', 'x', now(), now(), now(), '{}', '{"full_name":"__mu1_check__ A"}'),
    (v_b,     '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__mu1_check__b@example.com', 'x', now(), now(), now(), '{}', '{"full_name":"__mu1_check__ B"}'),
    (v_agent, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__mu1_check__agent@example.com', 'x', now(), now(), now(), '{}', '{"full_name":"__mu1_check__ Agent"}');

  SELECT account_id INTO v_acc_a   FROM public.profiles WHERE user_id = v_a;
  SELECT account_id INTO v_acc_b   FROM public.profiles WHERE user_id = v_b;
  SELECT account_id INTO v_acc_tmp FROM public.profiles WHERE user_id = v_agent;
  IF v_acc_a IS NULL OR v_acc_b IS NULL OR v_acc_tmp IS NULL THEN
    RAISE EXCEPTION 'FAIL 0: handle_new_user não criou account/profile para os fixtures';
  END IF;

  -- PASS 1: signup (handle_new_user → INSERT profile) cria a membership
  SELECT count(*) INTO v_count FROM public.account_members
  WHERE user_id IN (v_a, v_b, v_agent) AND role = 'owner' AND is_active;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'FAIL 1: esperado 3 memberships owner criadas pelo trigger no signup, encontrado %', v_count;
  END IF;
  RAISE NOTICE 'PASS 1: signup cria membership (via trigger profiles → account_members)';

  -- PASS 2: "move" 1:1 de hoje (create_account_member / redeem / attach):
  -- profile passa para a account A como agent → membership antiga some,
  -- nova aparece; continua 1 por usuário
  UPDATE public.profiles SET account_id = v_acc_a, account_role = 'agent' WHERE user_id = v_agent;
  SELECT count(*) INTO v_count FROM public.account_members WHERE user_id = v_agent;
  SELECT role::text INTO v_role FROM public.account_members WHERE user_id = v_agent AND account_id = v_acc_a;
  IF v_count <> 1 OR v_role IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'FAIL 2: após mover o profile esperado 1 membership agent em A (count=%, role=%)', v_count, v_role;
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_agent AND account_id = v_acc_tmp) THEN
    RAISE EXCEPTION 'FAIL 2b: membership na account antiga deveria ter sido removida';
  END IF;
  RAISE NOTICE 'PASS 2: move de profile reflete em account_members (antiga removida, nova criada)';

  -- PASS 3: set_member_role / platform_update_user (role e is_active)
  UPDATE public.profiles SET account_role = 'admin' WHERE user_id = v_agent;
  UPDATE public.profiles SET is_active = false WHERE user_id = v_agent;
  SELECT role::text, is_active INTO v_role, v_active FROM public.account_members
  WHERE user_id = v_agent AND account_id = v_acc_a;
  IF v_role IS DISTINCT FROM 'admin' OR v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 3: role/is_active não sincronizados (role=%, is_active=%)', v_role, v_active;
  END IF;
  UPDATE public.profiles SET is_active = true WHERE user_id = v_agent;
  RAISE NOTICE 'PASS 3: mudança de role e is_active no profile reflete na membership';

  -- PASS 4: UPDATE de coluna não relacionada NÃO dispara sync. Sinal: o
  -- ctid da membership (muda sempre que a linha é regravada; updated_at
  -- não serve — now() é constante dentro da transação).
  SELECT ctid::text INTO v_ctid FROM public.account_members WHERE user_id = v_agent;
  UPDATE public.profiles SET full_name = '__mu1_check__ renamed' WHERE user_id = v_agent;
  IF (SELECT ctid::text FROM public.account_members WHERE user_id = v_agent) IS DISTINCT FROM v_ctid THEN
    RAISE EXCEPTION 'FAIL 4: alterar full_name não deveria tocar account_members';
  END IF;
  RAISE NOTICE 'PASS 4: alterações de identidade (full_name) não mexem em memberships';

  -- PASS 5: idempotência do backfill — reexecutar não duplica nem altera
  SELECT count(*) INTO v_before FROM public.account_members;
  UPDATE public.account_members SET role = 'viewer' WHERE user_id = v_b;  -- divergência artificial
  INSERT INTO public.account_members (user_id, account_id, role, is_active)
  SELECT user_id, account_id, account_role, is_active FROM public.profiles
  ON CONFLICT (user_id, account_id) DO NOTHING;
  SELECT count(*) INTO v_count FROM public.account_members;
  SELECT role::text INTO v_role FROM public.account_members WHERE user_id = v_b;
  IF v_count <> v_before THEN
    RAISE EXCEPTION 'FAIL 5a: reexecutar o backfill mudou a contagem (% → %)', v_before, v_count;
  END IF;
  IF v_role IS DISTINCT FROM 'viewer' THEN
    RAISE EXCEPTION 'FAIL 5b: backfill DO NOTHING não deveria sobrescrever membership existente';
  END IF;
  UPDATE public.account_members SET role = 'owner' WHERE user_id = v_b;
  RAISE NOTICE 'PASS 5: backfill idempotente (sem duplicata, sem sobrescrever)';

  -- PASS 6: RLS — authenticated só lê; não escreve
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_b::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM public.account_members WHERE user_id = v_b;
  IF v_count <> 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL 6a: usuário deveria ler a própria membership (count=%)', v_count; END IF;
  SELECT count(*) INTO v_count FROM public.account_members WHERE account_id = v_acc_a;
  IF v_count <> 0 THEN RESET ROLE; RAISE EXCEPTION 'FAIL 6b: B (owner de outra account) não deveria ver memberships de A (count=%)', v_count; END IF;
  BEGIN
    INSERT INTO public.account_members (user_id, account_id, role) VALUES (v_b, v_acc_a, 'admin');
    RESET ROLE; RAISE EXCEPTION 'FAIL 6c: authenticated não pode criar membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.account_members SET role = 'owner' WHERE user_id = v_b;
    RESET ROLE; RAISE EXCEPTION 'FAIL 6d: authenticated não pode alterar papel';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.account_members WHERE user_id = v_b;
    RESET ROLE; RAISE EXCEPTION 'FAIL 6e: authenticated não pode remover membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  RAISE NOTICE 'PASS 6: authenticated lê só o próprio + não insere/altera/remove';

  -- PASS 7: owner/admin da account lê todas as memberships dela
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM public.account_members WHERE account_id = v_acc_a;
  RESET ROLE;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL 7: owner de A deveria ver 2 memberships (ele + agent), viu %', v_count;
  END IF;
  RAISE NOTICE 'PASS 7: admin/owner lê as memberships da própria account';

  -- PASS 8: DELETE de account em cascata remove memberships (sem erro)
  DELETE FROM public.accounts WHERE id = v_acc_tmp;  -- account pessoal que ficou vazia no PASS 2
  RAISE NOTICE 'PASS 8: cascade de account passa';

  RAISE NOTICE '=== MU-1 validation: TODOS OS TESTES PASSARAM ===';
END;
$outer$;

ROLLBACK;
