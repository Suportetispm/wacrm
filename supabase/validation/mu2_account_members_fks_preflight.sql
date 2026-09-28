-- ============================================================
-- mu2_account_members_fks_preflight.sql
--
-- Preflight da migration 081_account_members_membership_fks (ETAPA MU-2).
-- PRODUÇÃO — 100% SOMENTE LEITURA. Nenhum INSERT/UPDATE/DELETE/DDL.
--
-- Anotar os resultados marcados [SNAPSHOT]: o check pós-migration
-- compara contra eles. Qualquer "Esperado" divergente = PARAR.
-- ============================================================

-- 1. 079 aplicada: account_members existe, RLS ativa, alvo UNIQUE presente
SELECT to_regclass('public.account_members') AS account_members,
       (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.account_members')) AS rls_enabled,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = to_regclass('public.account_members')
           AND conname = 'account_members_user_id_account_id_key') AS unique_target;
-- Esperado: public.account_members / true / UNIQUE (user_id, account_id).

-- 2. 080 aplicada
SELECT pg_get_functiondef('public.account_has_any_data(uuid)'::regprocedure)
         ILIKE '%''account_members''%' AS hotfix_080_applied;
-- Esperado: true.

-- 3. MU-1 continua 1:1
SELECT
  (SELECT count(*) FROM public.profiles)        AS profiles,        -- [SNAPSHOT]
  (SELECT count(*) FROM public.account_members) AS memberships,     -- [SNAPSHOT]
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = p.user_id AND m.account_id = p.account_id)) AS profiles_without_membership,
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.user_id = m.user_id AND p.account_id = m.account_id)) AS memberships_without_profile,
  (SELECT count(*) - count(DISTINCT (user_id, account_id)) FROM public.account_members) AS duplicate_memberships,
  (SELECT count(*) FROM (SELECT user_id FROM public.account_members
                         GROUP BY user_id HAVING count(*) > 1) d) AS users_with_more_than_one_membership;
-- Esperado: profiles = memberships (21) / 0 / 0 / 0 / 0.

-- 4. Trigger temporário da MU-1 presente e ativo
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'sync_account_members';
-- Esperado: 1 linha, tgenabled = O.

-- 5. TODAS as FKs que apontam para profiles  [SNAPSHOT]
SELECT c.conrelid::regclass AS source_table, c.conname,
       c.confdeltype AS on_delete, c.confupdtype AS on_update, c.condeferrable,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
ORDER BY 1, 2;
-- Esperado: 4 linhas (on_delete c = CASCADE, n = SET NULL; on_update a = NO ACTION):
--   deals                     deals_assigned_to_fkey                            (assigned_to) → profiles(id)                    n / a
--   internal_team_members     internal_team_members_user_id_account_id_fkey     (user_id, account_id) → profiles(user_id, account_id) c / a
--   queue_members             queue_members_user_id_account_id_fkey             idem                                             c / a
--   user_permission_overrides user_permission_overrides_user_id_account_id_fkey idem                                             c / a
-- Nome diferente não é problema (a 081 localiza por definição), mas
-- on_delete/on_update/deferrable diferentes = PARAR (a 081 aborta).

-- 6. Nenhuma FK aponta para account_members ainda
SELECT count(*) AS fks_to_account_members
FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.account_members'::regclass;
-- Esperado: 0.

-- 7. Nomes que a 081 vai usar estão livres (exceto pelas próprias FKs antigas)
SELECT conrelid::regclass AS tbl, conname, confrelid::regclass AS points_to
FROM pg_constraint
WHERE conname IN ('queue_members_user_id_account_id_fkey',
                  'internal_team_members_user_id_account_id_fkey',
                  'user_permission_overrides_user_id_account_id_fkey');
-- Esperado: só as 3 FKs antigas (points_to = profiles), ou nenhuma linha.

-- 8. Contagens  [SNAPSHOT]
SELECT
  (SELECT count(*) FROM public.queue_members)             AS queue_members,
  (SELECT count(*) FROM public.internal_team_members)     AS internal_team_members,
  (SELECT count(*) FROM public.user_permission_overrides) AS user_permission_overrides,
  (SELECT count(*) FROM public.queues WHERE primary_agent_id IS NOT NULL) AS queues_with_primary_agent,
  (SELECT count(*) FROM public.deals WHERE assigned_to IS NOT NULL)       AS deals_assigned;

-- 9. Órfãos em relação ao alvo NOVO (account_members)
SELECT
  (SELECT count(*) FROM public.queue_members x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS queue_members_orphans,
  (SELECT count(*) FROM public.internal_team_members x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS internal_team_members_orphans,
  (SELECT count(*) FROM public.user_permission_overrides x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS user_permission_overrides_orphans;
-- Esperado: 0 / 0 / 0. Qualquer > 0 = PARAR (a 081 aborta).

-- 10. Vínculos por membership — o que um DELETE de membership apagaria
-- (informativo: dá a dimensão do cascade por usuário)
SELECT m.account_id, m.user_id, m.role, m.is_active,
       (SELECT count(*) FROM public.queue_members x
         WHERE x.user_id = m.user_id AND x.account_id = m.account_id)         AS queue_links,
       (SELECT count(*) FROM public.internal_team_members x
         WHERE x.user_id = m.user_id AND x.account_id = m.account_id)         AS team_links,
       (SELECT count(*) FROM public.user_permission_overrides x
         WHERE x.user_id = m.user_id AND x.account_id = m.account_id)         AS override_links,
       (SELECT count(*) FROM public.queues q
         WHERE q.account_id = m.account_id AND q.primary_agent_id = m.user_id) AS primary_agent_of
FROM public.account_members m
ORDER BY m.account_id, m.role, m.user_id;

-- 11. Índices das tabelas envolvidas  [SNAPSHOT]
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('queue_members', 'internal_team_members', 'user_permission_overrides',
                    'account_members', 'profiles')
ORDER BY tablename, indexname;
-- Esperado (entre outros): account_members_user_id_account_id_key,
-- idx_profiles_user_account, idx_queue_members_user,
-- idx_internal_team_members_user, idx_user_permission_overrides_lookup.

-- 12. Triggers das tabelas envolvidas  [SNAPSHOT]
SELECT tgrelid::regclass AS tbl, tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgrelid IN ('public.queue_members'::regclass, 'public.internal_team_members'::regclass,
                  'public.user_permission_overrides'::regclass, 'public.account_members'::regclass,
                  'public.profiles'::regclass, 'public.queues'::regclass)
ORDER BY 1, 2;
-- Esperado (relevantes): queue_members.clear_primary_agent_on_departure
-- (AFTER DELETE OR UPDATE OF is_active); internal_team_members.validate_active,
-- prevent_system_column_change; profiles.sync_account_members,
-- clear_primary_agent_on_deactivation, internal_tickets_handle_profile_deactivation,
-- enforce_profile_privilege_columns; queues.validate_primary_agent.

-- 13. RLS/policies  [SNAPSHOT]
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('queue_members', 'internal_team_members', 'user_permission_overrides',
                    'account_members', 'profiles')
ORDER BY tablename, policyname;

SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies_total,
  (SELECT md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''),
                         ',' ORDER BY tablename, policyname))
     FROM pg_policies WHERE schemaname = 'public')                AS policies_md5;

-- 14. Hashes de estado que a 081 NÃO pode tocar  [SNAPSHOT]
SELECT
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || account_role::text || ':' || is_active::text,
                         ',' ORDER BY user_id)) FROM public.profiles)           AS profiles_membership_hash,
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || role::text || ':' || is_active::text,
                         ',' ORDER BY user_id, account_id)) FROM public.account_members) AS account_members_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.queue_members)              AS queue_members_ids_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.internal_team_members)      AS internal_team_members_ids_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.user_permission_overrides)  AS user_permission_overrides_ids_hash,
  (SELECT md5(string_agg(id::text || ':' || coalesce(primary_agent_id::text, ''), ',' ORDER BY id))
     FROM public.queues)                                                         AS queues_primary_agent_hash,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.account_members_sync_from_profile()'::regprocedure) AS sync_fn_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.remove_account_member(uuid)'::regprocedure)        AS remove_account_member_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.account_has_any_data(uuid)'::regprocedure)         AS account_has_any_data_md5,
  (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.is_account_member(uuid, public.account_role_enum)'::regprocedure)                  AS is_account_member_md5;

-- 15. Funções que escrevem nas 3 tabelas ou em profiles.account_id
-- (informativo — nenhuma é alterada pela 081)
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.prosrc ~* '(insert into|delete from|update)\s+(public\.)?(queue_members|internal_team_members|user_permission_overrides)\b'
       OR p.prosrc ~* 'update\s+(public\.)?profiles\b')
ORDER BY p.proname;

-- ============================================================
-- FIM DO PREFLIGHT
-- ============================================================
