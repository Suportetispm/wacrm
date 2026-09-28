-- ============================================================
-- 080_account_has_any_data_hotfix_preflight.sql
--
-- Preflight da migration 080_account_has_any_data_account_members_hotfix.
-- PRODUÇÃO — 100% SOMENTE LEITURA. Nenhum INSERT/UPDATE/DELETE/DDL.
-- (account_has_any_data é STABLE e só faz SELECT — chamá-la é leitura.)
--
-- Anotar os resultados marcados com [SNAPSHOT]: o check pós-migration
-- compara contra eles.
-- ============================================================

-- 1/2. account_members existe e tem account_id
SELECT to_regclass('public.account_members') AS account_members,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'account_members'
                  AND column_name = 'account_id')          AS has_account_id;
-- Esperado: public.account_members / true.

-- 3. Função existe (assinatura exata)
SELECT to_regprocedure('public.account_has_any_data(uuid)') AS fn;
-- Esperado: account_has_any_data(uuid). NULL = PARAR.

-- 4. Definição vigente ainda NÃO exclui account_members (e é a da 055)
SELECT
  pg_get_functiondef(p.oid) ILIKE '%''account_members''%'     AS excludes_account_members,
  pg_get_functiondef(p.oid) ILIKE '%<> ''profiles''%'         AS excludes_profiles,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_types''%'    AS excl_types,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_statuses''%' AS excl_statuses,
  pg_get_functiondef(p.oid) ILIKE '%''internal_ticket_stages''%'   AS excl_stages,
  pg_get_functiondef(p.oid) ILIKE '%''internal_teams''%'           AS excl_teams,
  md5(p.prosrc)                                                    AS prosrc_md5   -- [SNAPSHOT]
FROM pg_proc p
WHERE p.oid = 'public.account_has_any_data(uuid)'::regprocedure;
-- Esperado: false / true / true / true / true / true.
-- excludes_account_members = true → a 080 (ou equivalente) já foi
-- aplicada; PARAR e investigar antes de reaplicar.

-- Corpo completo, para arquivar junto do snapshot
SELECT pg_get_functiondef('public.account_has_any_data(uuid)'::regprocedure) AS current_definition;

-- 5. Assinatura / retorno / security / volatility / search_path / owner / ACL  [SNAPSHOT]
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
-- Esperado: p_account_id uuid / boolean / plpgsql / true / s /
-- {search_path=public} / postgres / ACL só com postgres (sem EXECUTE
-- para PUBLIC ("=X"), anon, authenticated, service_role).

SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'account_has_any_data'
ORDER BY grantee;
-- Esperado: apenas postgres.

-- 6. Callers conhecidos presentes  [SNAPSHOT]
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS prosrc_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosrc ILIKE '%account_has_any_data%'
  AND p.proname <> 'account_has_any_data'
ORDER BY p.proname;
-- Esperado: 3 linhas —
--   create_account_member            (p_user_id uuid, p_account_role account_role_enum, p_full_name text, p_queue_ids uuid[])
--   platform_attach_user_to_account  (p_user_id uuid, p_account_id uuid, p_account_role account_role_enum, p_full_name text, p_queue_ids uuid[])
--   platform_create_account          (p_name text, p_owner_user_id uuid)

-- Tabelas que a função varre hoje (a lista NÃO filtrada pela exclusão
-- — mostra que account_members está nela)
SELECT c.table_name
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
  AND t.table_type = 'BASE TABLE'
  AND c.table_name <> 'profiles'
  AND c.table_name NOT IN ('internal_ticket_types', 'internal_ticket_statuses',
                           'internal_ticket_stages', 'internal_teams')
ORDER BY c.table_name;
-- Esperado: account_members presente na lista.  [SNAPSHOT: nº de linhas]

-- Resultado atual da função por account.
SELECT
  count(*)                                                         AS accounts_total,
  count(*) FILTER (WHERE public.account_has_any_data(a.id))        AS accounts_with_data_now,   -- [SNAPSHOT]
  count(*) FILTER (WHERE NOT public.account_has_any_data(a.id))    AS accounts_without_data_now -- [SNAPSHOT]
FROM public.accounts a;
-- Esperado hoje: accounts_without_data_now = 0 (toda account tem pelo
-- menos a membership do owner — é a própria regressão).

-- Accounts com membership e SEM nenhuma outra linha operacional
-- (candidatas a virar false). Lista vazia é normal: a compensação das
-- rotas apaga a account temporária quando o attach falha.
SELECT a.id, a.name, a.owner_user_id, a.created_at,
       (SELECT count(*) FROM public.account_members m WHERE m.account_id = a.id) AS memberships
FROM public.accounts a
WHERE EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.contacts x         WHERE x.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.conversations x    WHERE x.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config x  WHERE x.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.queues x           WHERE x.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.flows x            WHERE x.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.internal_companies x WHERE x.account_id = a.id)
ORDER BY a.created_at DESC;
-- Informativo (filtro parcial, só as tabelas mais comuns). A lista
-- exata vem do check pós-migration (accounts que passaram a false).

-- Snapshot de objetos que a 080 NÃO pode tocar  [SNAPSHOT]
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
-- Anotar tudo. sync_trigger_enabled esperado = 1.

-- ============================================================
-- FIM DO PREFLIGHT
-- ============================================================
