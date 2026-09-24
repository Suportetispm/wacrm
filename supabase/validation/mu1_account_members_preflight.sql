-- ============================================================
-- mu1_account_members_preflight.sql  (ETAPA MU-1)
--
-- Verificação SOMENTE LEITURA — segura em produção. Roda ANTES de
-- aplicar supabase/migrations/079_account_members.sql.
-- Apenas SELECT / introspecção. Nenhuma escrita, nenhum DDL, nenhum
-- BEGIN. account_members só é checada via to_regclass (ainda não existe).
--
-- Guarde o resultado do bloco 14 (SNAPSHOT): o check pós-migration
-- compara os mesmos hashes para provar que profiles e accounts não
-- mudaram.
-- ============================================================

-- 1. [BLOQUEANTE] account_members ainda não existe
SELECT to_regclass('public.account_members') AS account_members_table;
-- Esperado: NULL.

-- 2/3. [BLOQUEANTE] profiles = 21, distintos = 21
SELECT count(*) AS total_profiles, count(DISTINCT user_id) AS distinct_users
FROM public.profiles;
-- Esperado: 21 / 21 (estado real do MU-0). Se o número mudou desde o
-- MU-0 (novo cadastro), tudo bem desde que total = distintos — anotar o
-- valor: é o número exato de memberships que o backfill vai criar.

-- 4. [BLOQUEANTE] nenhum account_id NULL
SELECT count(*) AS profiles_account_null FROM public.profiles WHERE account_id IS NULL;
-- Esperado: 0.

-- 5. [BLOQUEANTE] nenhum profile órfão
SELECT count(*) AS profiles_orphan
FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p.account_id);
-- Esperado: 0.

-- 6. [BLOQUEANTE] nenhum owner inconsistente
SELECT
  (SELECT count(*) FROM public.accounts a
     LEFT JOIN public.profiles p ON p.user_id = a.owner_user_id
    WHERE p.user_id IS NULL OR p.account_id <> a.id OR p.account_role::text <> 'owner') AS accounts_owner_inconsistent,
  (SELECT count(*) FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.account_role::text = 'owner' AND a.owner_user_id <> p.user_id)              AS profiles_owner_not_account_owner;
-- Esperado: 0 / 0.

-- 7. [BLOQUEANTE] nenhuma duplicata (user_id, account_id)
SELECT count(*) - count(DISTINCT (user_id, account_id)) AS duplicate_user_account_pairs
FROM public.profiles;
-- Esperado: 0.

-- 8. [BLOQUEANTE] nenhuma role inválida / NULL; is_active nunca NULL
SELECT
  count(*) FILTER (WHERE account_role IS NULL)                                          AS null_role,
  count(*) FILTER (WHERE account_role::text NOT IN ('owner', 'admin', 'agent', 'viewer')) AS unknown_role,
  count(*) FILTER (WHERE is_active IS NULL)                                             AS null_is_active
FROM public.profiles;
-- Esperado: 0 / 0 / 0.

SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumlabel) AS account_role_enum_values
FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typname = 'account_role_enum';
-- Esperado: admin,agent,owner,viewer.

-- 9/10. [BLOQUEANTE] auth.users ↔ profiles
SELECT
  (SELECT count(*) FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id)) AS auth_users_without_profile,
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.user_id))     AS profiles_without_auth_user;
-- Esperado: 0 / 0.

-- 11. [BLOQUEANTE] as 3 FKs compostas de membership ainda apontam para profiles
SELECT c.conrelid::regclass AS source_table, c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
  AND array_length(c.conkey, 1) = 2
ORDER BY 1;
-- Esperado: 3 linhas —
--   internal_team_members_user_id_account_id_fkey
--   queue_members_user_id_account_id_fkey
--   user_permission_overrides_user_id_account_id_fkey
-- todas FOREIGN KEY (user_id, account_id) REFERENCES profiles(user_id, account_id) ON DELETE CASCADE.

-- 12. [BLOQUEANTE] deals.assigned_to → profiles.id (identidade global, fica)
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
  AND c.conrelid = 'public.deals'::regclass;
-- Esperado: 1 linha — deals_assigned_to_fkey: FOREIGN KEY (assigned_to)
-- REFERENCES profiles(id) ON DELETE SET NULL.

-- 13. [BLOQUEANTE] business_units continuam ausentes
SELECT to_regclass('public.business_units') AS business_units_table,
       to_regclass('public.user_business_units') AS user_business_units_table,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'business_unit_id') AS business_unit_id_columns;
-- Esperado: NULL / NULL / 0.

-- 14. SNAPSHOT (guardar) — hashes estáveis do estado atual
SELECT
  (SELECT count(*) FROM public.profiles) AS profiles_count,
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || account_role::text || ':' || is_active::text,
                         ',' ORDER BY user_id))
     FROM public.profiles)                                  AS profiles_membership_hash,
  (SELECT md5(string_agg(id::text || ':' || owner_user_id::text || ':' || is_active::text, ',' ORDER BY id))
     FROM public.accounts)                                  AS accounts_owner_hash,
  (SELECT max(updated_at) FROM public.profiles)             AS profiles_max_updated_at;
-- O check pós-migration recalcula os mesmos hashes: devem ser IDÊNTICOS
-- (a migration não toca profiles nem accounts).

-- 15. Contexto: helper updated_at existente (será reutilizado)
SELECT p.oid::regprocedure AS signature
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column';
-- Esperado: update_updated_at_column().

-- 16. Contexto: policies atuais (linha de base para o check)
SELECT
  count(*) FILTER (WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%is_account_member%') AS policies_using_is_account_member,
  count(*) FILTER (WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%profiles%')          AS policies_reading_profiles,
  count(*)                                                                                            AS total_policies
FROM pg_policies WHERE schemaname = 'public';
-- Esperado: 130 / 1 / (anotar total). Após a MU-1: +2 policies, ambas
-- em account_members (uma delas usa is_account_member → 131).

-- 17. Contexto: triggers atuais em profiles (a MU-1 adiciona 1)
SELECT tgname, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal
ORDER BY tgname;
