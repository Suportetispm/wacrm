-- ============================================================
-- 071_account_feature_flags_check.sql
--
-- Script de validação da migration 071 — NÃO É UMA MIGRATION, não é
-- aplicado automaticamente por nenhum runner (supabase db push ignora
-- arquivos fora de supabase/migrations/). Rodar manualmente contra
-- STAGING depois de aplicar 071 manualmente lá, NUNCA em produção.
--
-- Cobre os itens 5-18 da lista de "TESTES OBRIGATÓRIOS" da Etapa
-- Piloto 0 (itens 1-4 e 17-parcial são testados como unit tests puros
-- em src/lib/accounts/feature-flags.test.ts — este script cobre só o
-- que só pode ser verificado contra um Postgres real: RLS, grants,
-- a RPC, e o audit log):
--   5.  anon não consegue inserir flag
--   6.  authenticated comum (sem platform admin) não consegue inserir
--   7.  tenant admin não consegue habilitar flag diretamente (mesmo
--       sendo admin da própria conta)
--   8.  agent não consegue habilitar flag
--   9.  viewer não consegue habilitar flag
--   10. platform admin consegue habilitar via RPC
--   11. platform admin consegue desabilitar via RPC
--   12. feature_key inválida é rejeitada pela RPC
--   13. account inexistente é rejeitada pela RPC
--   14. alteração gera platform_audit_log
--   15. valor anterior e novo ficam corretamente registrados no log
--   16. account A não consegue acessar/alterar flag de B por caminho
--       tenant (RLS não abre NENHUM caminho tenant-scoped — provado
--       por introspecção de policies na Seção 1, e reforçado aqui)
--   18. nenhuma account recebe feature automaticamente (tabela nasce
--       vazia; nenhuma linha para nenhuma conta pré-existente)
--
-- SEGURANÇA DO SCRIPT: SEÇÃO 1 (assinatura/grants/policies) é só
-- introspecção via pg_proc/pg_policies/has_table_privilege() — zero
-- efeito colateral, segura em qualquer ambiente, inclusive produção.
-- SEÇÃO 2 (comportamental) cria dados sintéticos com prefixo
-- '__071_check__' e roda inteira dentro de BEGIN/ROLLBACK — desfeita
-- ao final independentemente do resultado. Mesmo assim, NÃO rodar a
-- Seção 2 em produção (mesma política de todo script de validação
-- deste projeto — ver 067/068/069).
--
-- PREMISSA sobre auth.uid()/roles: mesmo mecanismo de 068/069 — `SET
-- LOCAL request.jwt.claims` + `SET LOCAL ROLE <role>` simula o
-- chamador. Um bloco `BEGIN ... EXCEPTION WHEN insufficient_privilege`
-- é usado para provar que uma escrita direta é REALMENTE negada pelo
-- Postgres (não só "não tentada") — o savepoint implícito do handler
-- de exceção do plpgsql também desfaz o `SET LOCAL ROLE`, por isso não
-- é necessário `RESET ROLE` dentro do `WHEN`.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — Assinatura, grants e policies (somente leitura, seguro em
-- qualquer ambiente)
-- ============================================================

-- Assinatura esperada: platform_set_account_feature(uuid, text, boolean)
-- -> void, SECURITY DEFINER.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'platform_set_account_feature';

-- Grants da RPC: PUBLIC sem EXECUTE, authenticated com EXECUTE (a
-- própria função re-checa is_platform_admin() por dentro).
SELECT
  has_function_privilege('PUBLIC', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE') AS public_can_execute,
  has_function_privilege('anon', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')   AS anon_can_execute,
  has_function_privilege('authenticated', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE') AS authenticated_can_execute;
-- Esperado: public_can_execute = false, anon_can_execute = false,
-- authenticated_can_execute = true.

-- 16 (estrutural) — zero policies de RLS na tabela, para qualquer
-- role: nenhum caminho tenant-scoped existe, não é uma questão de
-- filtro por account_id, é ausência total de acesso via PostgREST.
SELECT count(*) AS policy_count
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'account_feature_flags';
-- Esperado: policy_count = 0.

-- Grants de tabela: nem anon nem authenticated têm qualquer privilégio
-- direto (SELECT/INSERT/UPDATE/DELETE) sobre account_feature_flags.
SELECT
  has_table_privilege('anon', 'public.account_feature_flags', 'SELECT')          AS anon_select,
  has_table_privilege('anon', 'public.account_feature_flags', 'INSERT')          AS anon_insert,
  has_table_privilege('authenticated', 'public.account_feature_flags', 'SELECT') AS authenticated_select,
  has_table_privilege('authenticated', 'public.account_feature_flags', 'INSERT') AS authenticated_insert;
-- Esperado: todos false.

-- ============================================================
-- SEÇÃO 2 — Comportamental (staging apenas, dentro de BEGIN/ROLLBACK)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_account_a         UUID := gen_random_uuid();
  v_account_b          UUID := gen_random_uuid();
  v_owner_a            UUID := gen_random_uuid();
  v_admin_a            UUID := gen_random_uuid();
  v_agent_a            UUID := gen_random_uuid();
  v_viewer_a           UUID := gen_random_uuid();
  v_platform_admin     UUID := gen_random_uuid();

  v_result RECORD;
  v_row_count INT;
  v_metadata JSONB;
  v_audit_count_before INT;
  v_audit_count_after INT;
BEGIN
  RAISE NOTICE '=== 071 validation: building synthetic fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner_a,        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__071_check__owner_a@example.com',    'x', now(), now(), now(), '{}', '{}'),
    (v_admin_a,        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__071_check__admin_a@example.com',    'x', now(), now(), now(), '{}', '{}'),
    (v_agent_a,        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__071_check__agent_a@example.com',    'x', now(), now(), now(), '{}', '{}'),
    (v_viewer_a,       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__071_check__viewer_a@example.com',   'x', now(), now(), now(), '{}', '{}'),
    (v_platform_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__071_check__platform_admin@example.com', 'x', now(), now(), now(), '{}', '{}');

  INSERT INTO public.accounts (id, name, owner_user_id, is_active)
  VALUES
    (v_account_a, '__071_check__ Account A', v_owner_a, true),
    (v_account_b, '__071_check__ Account B', v_owner_a, true);

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES
    (v_owner_a,  '__071_check__ Owner A',  '__071_check__owner_a@example.com',  v_account_a, 'owner',  true),
    (v_admin_a,  '__071_check__ Admin A',  '__071_check__admin_a@example.com',  v_account_a, 'admin',  true),
    (v_agent_a,  '__071_check__ Agent A',  '__071_check__agent_a@example.com',  v_account_a, 'agent',  true),
    (v_viewer_a, '__071_check__ Viewer A', '__071_check__viewer_a@example.com', v_account_a, 'viewer', true);

  INSERT INTO public.platform_admins (user_id) VALUES (v_platform_admin);

  RAISE NOTICE 'Fixtures ready.';

  -- ============================================================
  -- 18) nenhuma account recebe feature automaticamente — a tabela
  --     nasce vazia para as contas recém-criadas.
  -- ============================================================
  SELECT count(*) INTO v_row_count
  FROM public.account_feature_flags
  WHERE account_id IN (v_account_a, v_account_b);
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 18: esperava 0 linhas de account_feature_flags para contas novas, obteve %', v_row_count;
  END IF;
  RAISE NOTICE 'PASS 18: nenhuma feature habilitada automaticamente para contas novas';

  -- ============================================================
  -- 5) anon não consegue inserir
  -- ============================================================
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 5: anon conseguiu inserir diretamente — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 5: anon não consegue inserir (permission denied)';
  END;

  -- ============================================================
  -- 6) authenticated comum (sem platform admin) não consegue inserir
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 6: authenticated comum conseguiu inserir diretamente — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 6: authenticated comum não consegue inserir (permission denied)';
  END;

  -- ============================================================
  -- 7) tenant admin não consegue habilitar flag diretamente (mesmo
  --    sendo admin/owner da própria conta)
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_a)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 7: tenant admin conseguiu inserir diretamente — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 7: tenant admin não consegue habilitar flag diretamente';
  END;

  -- ============================================================
  -- 8) agent não consegue habilitar flag
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_a)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 8: agent conseguiu inserir diretamente — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 8: agent não consegue habilitar flag diretamente';
  END;

  -- ============================================================
  -- 9) viewer não consegue habilitar flag
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_viewer_a)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_feature_flags (account_id, feature_key, enabled)
    VALUES (v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 9: viewer conseguiu inserir diretamente — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 9: viewer não consegue habilitar flag diretamente';
  END;

  -- Tenant admin/agent/owner/viewer também não conseguem chamar a RPC
  -- com sucesso (a RPC exige is_platform_admin(), não só authenticated).
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_a)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.platform_set_account_feature(v_account_a, 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 7b: tenant admin conseguiu chamar a RPC com sucesso — deveria ter sido negado';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 7b: tenant admin não passa em is_platform_admin() dentro da RPC';
  END;

  -- ============================================================
  -- 10) platform admin consegue habilitar via RPC
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_admin)::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.platform_set_account_feature(v_account_a, 'multi_connection_enabled', true);
  RESET ROLE;

  SELECT enabled INTO v_result FROM public.account_feature_flags
  WHERE account_id = v_account_a AND feature_key = 'multi_connection_enabled';
  IF NOT FOUND OR v_result.enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: platform admin deveria conseguir habilitar via RPC';
  END IF;
  RAISE NOTICE 'PASS 10: platform admin habilita via RPC com sucesso';

  -- ============================================================
  -- 11) platform admin consegue desabilitar via RPC
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_admin)::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.platform_set_account_feature(v_account_a, 'multi_connection_enabled', false);
  RESET ROLE;

  SELECT enabled INTO v_result FROM public.account_feature_flags
  WHERE account_id = v_account_a AND feature_key = 'multi_connection_enabled';
  IF NOT FOUND OR v_result.enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 11: platform admin deveria conseguir desabilitar via RPC';
  END IF;
  RAISE NOTICE 'PASS 11: platform admin desabilita via RPC com sucesso';

  -- ============================================================
  -- 12) feature_key inválida é rejeitada
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_admin)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.platform_set_account_feature(v_account_a, 'not_a_real_feature', true);
    RAISE EXCEPTION 'FAIL 12: feature_key inválida deveria ter sido rejeitada';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE <> '22023' THEN
        RAISE EXCEPTION 'FAIL 12: esperava SQLSTATE 22023, obteve % (%)', SQLSTATE, SQLERRM;
      END IF;
      RAISE NOTICE 'PASS 12: feature_key inválida rejeitada com 22023';
  END;

  -- ============================================================
  -- 13) account inexistente é rejeitada
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_admin)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.platform_set_account_feature(gen_random_uuid(), 'multi_connection_enabled', true);
    RAISE EXCEPTION 'FAIL 13: account inexistente deveria ter sido rejeitada';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE <> '22023' THEN
        RAISE EXCEPTION 'FAIL 13: esperava SQLSTATE 22023, obteve % (%)', SQLSTATE, SQLERRM;
      END IF;
      RAISE NOTICE 'PASS 13: account inexistente rejeitada com 22023';
  END;

  -- ============================================================
  -- 14/15) alteração gera platform_audit_log, com valor anterior e
  --        novo corretamente registrados
  -- ============================================================
  SELECT count(*) INTO v_audit_count_before
  FROM public.platform_audit_log
  WHERE target_account_id = v_account_b
    AND action = 'platform_account_feature.set';

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_admin)::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.platform_set_account_feature(v_account_b, 'business_units_enabled', true);
  RESET ROLE;

  SELECT count(*) INTO v_audit_count_after
  FROM public.platform_audit_log
  WHERE target_account_id = v_account_b
    AND action = 'platform_account_feature.set';

  IF v_audit_count_after <> v_audit_count_before + 1 THEN
    RAISE EXCEPTION 'FAIL 14: esperava exatamente +1 linha em platform_audit_log, antes=% depois=%', v_audit_count_before, v_audit_count_after;
  END IF;
  RAISE NOTICE 'PASS 14: platform_audit_log ganhou exatamente 1 linha nova';

  SELECT metadata INTO v_metadata
  FROM public.platform_audit_log
  WHERE target_account_id = v_account_b
    AND action = 'platform_account_feature.set'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_metadata->>'feature_key' IS DISTINCT FROM 'business_units_enabled'
     OR (v_metadata->>'previous_enabled')::boolean IS DISTINCT FROM false
     OR (v_metadata->>'new_enabled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 15: metadata do audit log incorreto: %', v_metadata;
  END IF;
  RAISE NOTICE 'PASS 15: metadata registra feature_key/previous_enabled/new_enabled corretamente';

  -- ============================================================
  -- 16) reforço comportamental: mesmo um platform admin não altera
  --     conta inexistente/de outra "origem" por engano — já coberto
  --     estruturalmente pela ausência de policies (Seção 1); aqui só
  --     confirma que account_id É respeitado (a RPC nunca ignora o
  --     parâmetro e nunca afeta outra linha).
  -- ============================================================
  SELECT enabled INTO v_result FROM public.account_feature_flags
  WHERE account_id = v_account_a AND feature_key = 'business_units_enabled';
  IF FOUND THEN
    RAISE EXCEPTION 'FAIL 16: alterar a flag da account B não deveria ter criado/alterado nenhuma linha para account A';
  END IF;
  RAISE NOTICE 'PASS 16: alteração em account_id=B não vaza nem afeta account_id=A';

  RAISE NOTICE '=== 071 validation: TODOS OS TESTES 5-18 PASSARAM ===';
END;
$outer$;

ROLLBACK;
