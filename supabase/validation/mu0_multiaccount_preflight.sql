-- ============================================================
-- mu0_multiaccount_preflight.sql  (ETAPA MU-0)
--
-- Preflight SOMENTE LEITURA da futura sequência multiempresa
-- (user N:N account) e unidades (business_units / user_business_units).
-- Valida no banco real as premissas da auditoria multiempresa.
--
-- 100% leitura: apenas SELECT e introspecção de catálogo (pg_*,
-- information_schema). Nenhum INSERT/UPDATE/DELETE/DDL/LOCK/GRANT,
-- nenhum BEGIN, nenhuma função com efeito colateral. Seguro em produção.
--
-- Tabelas que talvez NÃO existam (account_members, business_units,
-- user_business_units) são checadas só via to_regclass() — nunca
-- referenciadas diretamente, para o script não quebrar.
--
-- Não seleciona senhas, tokens, hashes nem e-mails em claro — só
-- contagens e ids.
--
-- Blocos marcados [BLOQUEANTE] devem interromper a MU-1 se divergirem
-- do esperado. O bloco 16 consolida tudo em CHECK | STATUS | DETAIL.
-- ============================================================


-- ============================================================
-- 1. PROFILES
-- ============================================================

-- 1a. Colunas relevantes
SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
  AND column_name IN ('id', 'user_id', 'account_id', 'account_role', 'is_active', 'email', 'full_name')
ORDER BY column_name;
-- Esperado: account_id uuid NOT NULL (is_nullable = NO); account_role
-- udt account_role_enum NOT NULL; is_active boolean; user_id NOT NULL.

-- 1b. [BLOQUEANTE] UNIQUE em profiles.user_id + UNIQUE(user_id, account_id)
SELECT i.relname AS index_name, ix.indisunique, pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = 'public.profiles'::regclass
ORDER BY i.relname;
-- Esperado: profiles_pkey (id); profiles_user_id_key UNIQUE (user_id);
-- idx_profiles_user_account UNIQUE (user_id, account_id) (039);
-- idx_profiles_account_role, idx_profiles_account_active.

-- 1c. Contagens e anomalias
SELECT
  (SELECT count(*) FROM public.profiles)                                   AS total_profiles,
  (SELECT count(DISTINCT user_id) FROM public.profiles)                    AS distinct_users,
  (SELECT count(*) FROM public.profiles WHERE account_id IS NULL)          AS account_id_null,
  (SELECT count(*) FROM public.profiles WHERE account_role IS NULL)        AS account_role_null,
  (SELECT count(*) FROM (SELECT user_id FROM public.profiles
                         GROUP BY user_id HAVING count(*) > 1) d)          AS users_with_duplicate_profiles,
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p.account_id)) AS profiles_orphan_account,
  (SELECT count(*) FROM public.profiles WHERE is_active = false)           AS inactive_profiles;
-- Esperado: total_profiles = distinct_users; account_id_null = 0;
-- account_role_null = 0; users_with_duplicate_profiles = 0;
-- profiles_orphan_account = 0. inactive_profiles é informativo.

-- 1d. Distribuição de papéis
SELECT account_role, is_active, count(*) AS profiles
FROM public.profiles
GROUP BY account_role, is_active
ORDER BY account_role, is_active;


-- ============================================================
-- 2. ACCOUNTS
-- ============================================================

-- 2a. Colunas
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'accounts'
ORDER BY ordinal_position;

-- 2b. [BLOQUEANTE p/ "dono de várias empresas"] índice 1 account por owner
SELECT i.relname AS index_name, ix.indisunique, pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = 'public.accounts'::regclass
ORDER BY i.relname;
-- Esperado: idx_accounts_one_per_owner UNIQUE (owner_user_id). Não
-- bloqueia a MU-1 (backfill), mas precisa ser relaxado na MU-4 se um
-- usuário for DONO de mais de uma empresa.

-- 2c. Contagens
SELECT
  (SELECT count(*) FROM public.accounts)                                   AS total_accounts,
  (SELECT count(*) FROM public.accounts WHERE is_active = false)           AS inactive_accounts,
  (SELECT count(*) FROM public.accounts WHERE owner_user_id IS NULL)       AS accounts_without_owner,
  (SELECT count(*) FROM (SELECT owner_user_id FROM public.accounts
                         GROUP BY owner_user_id HAVING count(*) > 1) d)    AS owners_with_multiple_accounts,
  (SELECT count(*) FROM public.accounts a
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = a.owner_user_id)) AS owner_without_profile,
  (SELECT count(*) FROM public.accounts a
    JOIN public.profiles p ON p.user_id = a.owner_user_id
    WHERE p.account_id <> a.id)                                            AS owner_profile_in_other_account,
  (SELECT count(*) FROM public.accounts a
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.account_id = a.id)) AS accounts_without_any_profile;
-- Esperado: accounts_without_owner = 0; owners_with_multiple_accounts = 0;
-- owner_without_profile = 0; owner_profile_in_other_account = 0.
-- accounts_without_any_profile > 0 = account órfã (informativo).


-- ============================================================
-- 3. [BLOQUEANTE] ACCOUNT_MEMBERS — deve NÃO existir
-- ============================================================

SELECT
  to_regclass('public.account_members')  AS account_members_table,
  to_regclass('public.account_memberships') AS account_memberships_table;
-- Esperado: NULL, NULL. Se qualquer um vier preenchido, PARAR: a
-- auditoria multiempresa está desatualizada — documentar o schema real
-- com o bloco abaixo antes de qualquer MU-1.

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('account_members', 'account_memberships')
ORDER BY table_name, ordinal_position;
-- Esperado: 0 linhas.


-- ============================================================
-- 4. ROLES — account_role_enum
-- ============================================================

SELECT e.enumsortorder, e.enumlabel
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typname = 'account_role_enum'
ORDER BY e.enumsortorder;
-- Esperado: exatamente owner, admin, agent, viewer (qualquer ordem de
-- enumsortorder — o rank real está em is_account_member, bloco 7).
-- 'manager'/'supervisor' NÃO devem aparecer.

-- Contexto: papel POR FILA já existe (não é papel de account)
SELECT pg_get_constraintdef(c.oid) AS queue_members_role_in_queue_check
FROM pg_constraint c
WHERE c.conrelid = 'public.queue_members'::regclass AND c.contype = 'c'
  AND pg_get_constraintdef(c.oid) ILIKE '%role_in_queue%';
-- Esperado: CHECK (role_in_queue IN ('agent','supervisor')).


-- ============================================================
-- 5. FKs QUE APONTAM PARA profiles
-- ============================================================

SELECT
  c.conrelid::regclass                                        AS source_table,
  c.conname                                                   AS constraint_name,
  (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
     FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS source_columns,
  (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
     FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS target_columns,
  CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                     WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
  CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                     WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
  pg_get_constraintdef(c.oid)                                 AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
ORDER BY source_table, constraint_name;
-- Esperado: queue_members, user_permission_overrides e
-- internal_team_members, todas (user_id, account_id) →
-- profiles(user_id, account_id), ON DELETE CASCADE, ON UPDATE NO ACTION.
-- Qualquer tabela ALÉM dessas três = dependência nova a incluir na MU-2.
-- ON UPDATE NO ACTION é o motivo de a troca de account ativa (MU-3)
-- só poder vir DEPOIS de reapontar essas FKs (MU-2).


-- ============================================================
-- 6. DADOS DEPENDENTES — contagens e órfãos
-- ============================================================

SELECT 'queue_members' AS table_name,
       count(*) AS total_rows,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id)) AS orphans_vs_profiles,
       count(DISTINCT user_id) AS distinct_users
FROM public.queue_members t
UNION ALL
SELECT 'user_permission_overrides', count(*),
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id)),
       count(DISTINCT user_id)
FROM public.user_permission_overrides t
UNION ALL
SELECT 'internal_team_members', count(*),
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id)),
       count(DISTINCT user_id)
FROM public.internal_team_members t;
-- Esperado: orphans_vs_profiles = 0 nas três (as FKs garantem).


-- ============================================================
-- 7. RLS / HELPERS
-- ============================================================

-- 7a. Definição atual de is_account_member
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer,
       p.provolatile AS volatility, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'is_account_member';
-- Esperado: 1 linha, is_account_member(uuid, account_role_enum),
-- SECURITY DEFINER, STABLE; corpo lê profiles p JOIN accounts a
-- WHERE p.user_id = auth.uid() AND p.account_id = target AND p.is_active
-- AND a.is_active, com rank owner 4 / admin 3 / agent 2 / viewer 1 (048).

-- 7b. Quantas policies dependem de is_account_member / leem profiles direto
SELECT
  count(*)                                                                  AS total_policies,
  count(*) FILTER (WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%is_account_member%') AS using_is_account_member,
  count(*) FILTER (WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%profiles%')          AS reading_profiles_directly,
  count(DISTINCT tablename)                                                 AS tables_with_policies
FROM pg_policies
WHERE schemaname = 'public';

-- 7c. Detalhe das policies que leem profiles diretamente
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%profiles%'
ORDER BY tablename, policyname;
-- Informativo: essas policies precisam de revisão explícita quando a
-- membership sair de profiles (a auditoria encontrou ~6 nas migrations).

-- 7d. Tabelas com RLS desabilitada no schema public (contexto)
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY c.relname;
-- Informativo.


-- ============================================================
-- 8. RPCs / FUNCTIONS que leem o profile do chamador
-- ============================================================

SELECT
  p.proname,
  p.oid::regprocedure                                                      AS signature,
  p.prosecdef                                                              AS security_definer,
  (p.prosrc ILIKE '%account_role%')                                        AS reads_account_role,
  (p.prosrc ILIKE '%p_account_id%')                                        AS takes_account_param,
  CASE
    WHEN p.proname ~ '^(create_account_member|remove_account_member|set_member_role)$' THEN 'membership'
    WHEN p.proname ~ '(ticket)' AND p.proname !~ '^internal' THEN 'ticket'
    WHEN p.proname ~ '^(transfer_account_ownership)$' THEN 'ownership'
    WHEN p.proname ~ '(invitation)' THEN 'invitation'
    WHEN p.proname ~ '^platform_' THEN 'platform admin'
    WHEN p.proname = 'is_account_member' THEN 'RLS helper'
    ELSE 'outros'
  END                                                                      AS category
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND p.prosrc ~* '(from|join)\s+(public\.)?profiles'
  AND p.prosrc ~* '(auth\.uid\(\)|v_caller|v_uid)'
ORDER BY category, p.proname;
-- Esperado (~18-20, conforme a auditoria): is_account_member,
-- claim_ticket, close_ticket, resume_ticket, mark_ticket_waiting_customer,
-- transfer_ticket_agent, transfer_ticket_queue,
-- conversation_has_active_ticket, save_flow_graph (se 070 aplicada),
-- touch_presence, notify_conversation_assigned, create_account_member,
-- set_member_role, remove_account_member, transfer_account_ownership,
-- redeem_invitation, platform_create_account, platform_update_user,
-- platform_attach_user_to_account.
-- Funções que derivam a account do chamador via
-- `SELECT p.account_id INTO ... WHERE p.user_id = auth.uid()` passam a
-- escolher uma account ARBITRÁRIA se profiles algum dia tiver N linhas
-- por usuário — por isso o desenho recomendado mantém profiles 1:1.

-- 8b. Funções que ESCREVEM em profiles.account_id / account_role
SELECT p.proname, p.oid::regprocedure AS signature, p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.prosrc ~* 'update\s+(public\.)?profiles'
  AND p.prosrc ~* '(account_id|account_role)'
ORDER BY p.proname;
-- Esperado: redeem_invitation, create_account_member, set_member_role,
-- remove_account_member, transfer_account_ownership,
-- platform_attach_user_to_account, platform_update_user (lista da
-- auditoria; divergências indicam função não mapeada).


-- ============================================================
-- 9. INVITATIONS
-- ============================================================

-- 9a. Colunas
SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'account_invitations'
ORDER BY ordinal_position;
-- Esperado: id, account_id, token_hash, role, created_by_user_id, label,
-- created_at, expires_at, accepted_at, accepted_by_user_id.
-- NÃO deve haver coluna de e-mail (convite é só por link/token).

-- 9b. Constraints
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.account_invitations'::regclass
ORDER BY contype, conname;

-- 9c. RLS + policies
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_invitations'::regclass;
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'account_invitations'
ORDER BY policyname;

-- 9d. Estado dos convites (sem token/hash)
SELECT
  count(*)                                                       AS total,
  count(*) FILTER (WHERE accepted_at IS NULL AND expires_at > now()) AS pending_valid,
  count(*) FILTER (WHERE accepted_at IS NULL AND expires_at <= now()) AS expired,
  count(*) FILTER (WHERE accepted_at IS NOT NULL)                 AS accepted
FROM public.account_invitations;

-- 9e. Definição vigente de redeem_invitation / peek_invitation (NÃO executa)
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer,
       array_to_string(p.proacl, ', ') AS acl, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('redeem_invitation', 'peek_invitation')
ORDER BY p.proname;
-- Esperado (019): redeem_invitation recusa quem já está em account
-- compartilhada ("sign up with a different email") ou tem dados, faz
-- UPDATE profiles SET account_id/account_role e DELETE FROM accounts
-- da account pessoal antiga. Confirmar que o corpo ainda é esse.


-- ============================================================
-- 10. CADASTRO DE MEMBROS — o banco consegue representar
--     (mesmo user_id, account A) + (mesmo user_id, account B)?
-- ============================================================

-- 10a. Existe alguma tabela com (user_id, account_id) SEM unicidade só
--      por user_id, que pudesse representar N memberships? Lista todas as
--      tabelas do public com ambas as colunas, e se user_id sozinho é UNIQUE.
SELECT
  c.table_name,
  EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]
    WHERE ix.indrelid = ('public.' || c.table_name)::regclass
      AND ix.indisunique AND ix.indnatts = 1 AND a.attname = 'user_id'
  ) AS user_id_alone_is_unique
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
  AND EXISTS (SELECT 1 FROM information_schema.columns c2
              WHERE c2.table_schema = 'public' AND c2.table_name = c.table_name
                AND c2.column_name = 'account_id')
  AND EXISTS (SELECT 1 FROM information_schema.tables t
              WHERE t.table_schema = 'public' AND t.table_name = c.table_name
                AND t.table_type = 'BASE TABLE')
ORDER BY c.table_name;
-- Esperado: profiles com user_id_alone_is_unique = true (é o bloqueio).
-- queue_members / user_permission_overrides / internal_team_members etc.
-- aparecem, mas DEPENDEM de profiles(user_id, account_id) via FK — não
-- representam membership sozinhos. Nenhuma tabela de membership N:N.

-- 10b. Funções usadas pelas rotas de cadastro (definição, NÃO executa)
SELECT p.proname, p.oid::regprocedure AS signature, p.prosecdef AS security_definer,
       array_to_string(p.proacl, ', ') AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('create_account_member', 'platform_attach_user_to_account', 'handle_new_user')
ORDER BY p.proname;
-- POST /api/account/members → auth.admin.createUser + create_account_member;
-- POST /api/admin/users → auth.admin.createUser + platform_attach_user_to_account.
-- Ambas exigem que o usuário alvo seja 'owner' da própria account
-- temporária (recém-criada por handle_new_user) e a MOVEM.

-- 10c. Trigger de criação de account/profile no signup
SELECT tgname, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
ORDER BY tgname;
-- Esperado: on_auth_user_created → handle_new_user().


-- ============================================================
-- 11. CONSISTÊNCIA DE OWNER (antes do backfill)
-- ============================================================

WITH o AS (
  SELECT a.id AS account_id, a.owner_user_id, p.account_id AS owner_profile_account,
         p.account_role AS owner_profile_role
  FROM public.accounts a
  LEFT JOIN public.profiles p ON p.user_id = a.owner_user_id
)
SELECT classification, count(*) AS accounts
FROM (
  SELECT CASE
           WHEN owner_user_id IS NULL                         THEN '3. account sem owner_user_id'
           WHEN owner_profile_account IS NULL                 THEN '2. owner sem profile'
           WHEN owner_profile_account <> account_id           THEN '4. profile do owner aponta para outra account'
           WHEN owner_profile_role::text <> 'owner'           THEN '5. owner_user_id cujo profile não tem role owner'
           ELSE                                                    '1. owner correto'
         END AS classification
  FROM o
) x
GROUP BY classification
UNION ALL
SELECT '6. profile role owner que NÃO é owner_user_id da sua account', count(*)
FROM public.profiles p
JOIN public.accounts a ON a.id = p.account_id
WHERE p.account_role::text = 'owner' AND a.owner_user_id <> p.user_id
UNION ALL
SELECT '7. accounts com mais de 1 profile role owner', count(*)
FROM (SELECT account_id FROM public.profiles WHERE account_role::text = 'owner'
      GROUP BY account_id HAVING count(*) > 1) d
ORDER BY 1;
-- Esperado: só a linha '1. owner correto' com count = total_accounts;
-- linhas 2-7 ausentes ou com 0.


-- ============================================================
-- 12. BACKFILL PREVIEW — futura origem de account_members (NÃO grava)
-- ============================================================

WITH src AS (
  SELECT user_id, account_id, account_role, is_active FROM public.profiles
)
SELECT
  count(*)                                                           AS memberships_to_create,
  count(*) - count(DISTINCT (user_id, account_id))                   AS duplicate_user_account_pairs,
  count(*) FILTER (WHERE user_id IS NULL OR account_id IS NULL)      AS rows_with_null_keys,
  count(*) FILTER (WHERE account_role IS NULL)                       AS rows_with_null_role,
  count(*) FILTER (WHERE account_role::text NOT IN ('owner', 'admin', 'agent', 'viewer')) AS rows_with_unknown_role,
  count(*) FILTER (WHERE is_active IS NULL)                          AS rows_with_null_is_active,
  count(*) FILTER (WHERE is_active = false)                          AS inactive_memberships
FROM src;
-- Esperado: memberships_to_create = total_profiles (bloco 1c);
-- duplicate_user_account_pairs = 0; rows_with_null_keys = 0;
-- rows_with_null_role = 0; rows_with_unknown_role = 0;
-- rows_with_null_is_active = 0. inactive_memberships é informativo
-- (vira account_members.is_active = false, sem perder a linha).

-- Distribuição que o backfill produziria
SELECT account_role, is_active, count(*) AS memberships
FROM public.profiles
GROUP BY account_role, is_active
ORDER BY account_role, is_active;


-- ============================================================
-- 13. auth.users × profiles (sem senha/token/e-mail em claro)
-- ============================================================

SELECT
  (SELECT count(*) FROM auth.users)                                      AS total_auth_users,
  (SELECT count(*) FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id)) AS auth_users_without_profile,
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.user_id)) AS profiles_without_auth_user,
  (SELECT count(*) FROM (SELECT lower(email) FROM auth.users WHERE email IS NOT NULL
                         GROUP BY lower(email) HAVING count(*) > 1) d)   AS duplicate_emails_case_insensitive,
  (SELECT count(*) FROM auth.users u
    JOIN public.profiles p ON p.user_id = u.id
    WHERE lower(coalesce(u.email, '')) <> lower(coalesce(p.email, '')))  AS profile_email_differs_from_auth,
  (SELECT count(*) FROM auth.users WHERE deleted_at IS NOT NULL)         AS soft_deleted_auth_users,
  (SELECT count(*) FROM auth.users WHERE banned_until IS NOT NULL AND banned_until > now()) AS banned_auth_users,
  (SELECT count(*) FROM public.platform_admins)                          AS platform_admins;
-- Esperado: auth_users_without_profile = 0 (handle_new_user cria sempre);
-- profiles_without_auth_user = 0 (FK CASCADE);
-- duplicate_emails_case_insensitive = 0 — confirma que HOJE ninguém
-- contornou o problema criando 2 logins para a mesma pessoa com o mesmo
-- e-mail. profile_email_differs_from_auth é informativo (profiles.email é
-- cópia do cadastro; mudança de e-mail no auth não propaga).

-- 13b. Usuários com "account pessoal" provavelmente temporária/sobra
--      (owner de account sem nenhum outro membro e sem dados) — contexto
--      para a MU-4 (convites que hoje apagam essa account).
SELECT count(*) AS solo_owner_accounts_without_data
FROM public.accounts a
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.account_id = a.id AND p.user_id <> a.owner_user_id)
  AND NOT EXISTS (SELECT 1 FROM public.contacts WHERE account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.conversations WHERE account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config WHERE account_id = a.id);
-- Informativo.


-- ============================================================
-- 14. FEATURE FLAGS
-- ============================================================

-- 14a. Chaves permitidas pelo CHECK (nome real)
SELECT to_regclass('public.account_feature_flags') IS NOT NULL AS feature_flags_table_exists;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = to_regclass('public.account_feature_flags')
  AND contype = 'c'
ORDER BY conname;
-- Esperado: feature_key = ANY (ARRAY['multi_connection_enabled',
-- 'business_units_enabled']). NÃO existe chave de "multiaccount" — a
-- multiempresa não é por account (é por usuário), então não há flag.

-- 14b. Estado atual (a tabela existe em produção — confirmado no
--      preflight da 078A). Se 14a retornou false, NÃO rodar este bloco.
SELECT feature_key, enabled, count(*) AS accounts
FROM public.account_feature_flags
GROUP BY feature_key, enabled
ORDER BY feature_key, enabled;
-- Esperado: nenhuma linha com enabled = true (multi_connection_enabled
-- e business_units_enabled desligadas em todas as accounts).


-- ============================================================
-- 15. [BLOQUEANTE] BUSINESS UNITS — devem NÃO existir
-- ============================================================

SELECT
  to_regclass('public.business_units')      AS business_units_table,
  to_regclass('public.user_business_units') AS user_business_units_table;
-- Esperado: NULL, NULL. Se existir, PARAR e documentar o schema real.

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name IN ('business_units', 'user_business_units')
       OR column_name = 'business_unit_id')
ORDER BY table_name, ordinal_position;
-- Esperado: 0 linhas (nenhuma tabela e nenhuma coluna business_unit_id
-- em lugar nenhum — incluindo queues e whatsapp_config).


-- ============================================================
-- 16. OUTPUT CONSOLIDADO — CHECK | STATUS | DETAIL
--     (roda sozinho; só usa tabelas que existem com certeza, e
--      to_regclass para as que podem não existir)
-- ============================================================

WITH m AS (
  SELECT
    (SELECT count(*) FROM public.profiles)                                          AS total_profiles,
    (SELECT count(DISTINCT user_id) FROM public.profiles)                           AS distinct_users,
    (SELECT count(*) FROM public.profiles WHERE account_id IS NULL)                 AS profile_account_null,
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'account_id') AS account_id_nullable,
    EXISTS (SELECT 1 FROM pg_index ix JOIN pg_attribute a
              ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]
            WHERE ix.indrelid = 'public.profiles'::regclass AND ix.indisunique
              AND ix.indnatts = 1 AND a.attname = 'user_id')                        AS user_id_unique,
    EXISTS (SELECT 1 FROM pg_index ix
            WHERE ix.indrelid = 'public.profiles'::regclass AND ix.indisunique
              AND ix.indnatts = 2
              AND pg_get_indexdef(ix.indexrelid) ILIKE '%(user_id, account_id)%')   AS user_account_unique,
    (SELECT count(*) FROM public.profiles p
      WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p.account_id)) AS profile_orphans,
    to_regclass('public.account_members') IS NULL
      AND to_regclass('public.account_memberships') IS NULL                        AS account_members_absent,
    (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumlabel)
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'account_role_enum')               AS enum_values,
    (SELECT count(*) FROM public.accounts a
      LEFT JOIN public.profiles p ON p.user_id = a.owner_user_id
      WHERE p.user_id IS NULL OR p.account_id <> a.id OR p.account_role::text <> 'owner') AS owner_inconsistent,
    (SELECT count(*) FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
      WHERE p.account_role::text = 'owner' AND a.owner_user_id <> p.user_id)       AS extra_owner_profiles,
    (SELECT count(*) FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass)          AS fks_to_profiles,
    (SELECT string_agg(c.conrelid::regclass::text, ', ' ORDER BY c.conrelid::regclass::text)
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass)          AS fk_source_tables,
    (SELECT count(*) FROM public.queue_members t WHERE NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id))
    + (SELECT count(*) FROM public.user_permission_overrides t WHERE NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id))
    + (SELECT count(*) FROM public.internal_team_members t WHERE NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.user_id = t.user_id AND p.account_id = t.account_id)) AS dependent_orphans,
    (SELECT count(*) - count(DISTINCT (user_id, account_id)) FROM public.profiles)  AS backfill_duplicates,
    (SELECT count(*) FROM public.profiles
      WHERE user_id IS NULL OR account_id IS NULL OR account_role IS NULL OR is_active IS NULL) AS backfill_nulls,
    (SELECT count(*) FROM auth.users u
      WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id))    AS auth_without_profile,
    (SELECT count(*) FROM public.profiles p
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.user_id))         AS profile_without_auth,
    (SELECT count(*) FROM (SELECT lower(email) FROM auth.users WHERE email IS NOT NULL
                           GROUP BY lower(email) HAVING count(*) > 1) d)            AS duplicate_emails,
    to_regclass('public.business_units') IS NULL
      AND to_regclass('public.user_business_units') IS NULL                        AS business_units_absent,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'business_unit_id')          AS business_unit_id_columns,
    EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
            WHERE ix.indrelid = 'public.accounts'::regclass
              AND i.relname = 'idx_accounts_one_per_owner')                         AS one_per_owner_index,
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
      AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%is_account_member%') AS policies_using_helper,
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
      AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%profiles%')        AS policies_reading_profiles
)
SELECT * FROM (
  SELECT 1 AS ord, 'profile único por usuário' AS check_name,
    CASE WHEN user_id_unique AND total_profiles = distinct_users THEN 'OK' ELSE 'BLOQUEANTE' END AS status,
    format('profiles=%s, usuários distintos=%s, UNIQUE(user_id)=%s', total_profiles, distinct_users, user_id_unique) AS detail
  FROM m
  UNION ALL
  SELECT 2, 'UNIQUE(user_id, account_id) em profiles (alvo das FKs)',
    CASE WHEN user_account_unique THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('idx (user_id, account_id) presente=%s', user_account_unique) FROM m
  UNION ALL
  SELECT 3, 'profiles.account_id NOT NULL e sem NULLs',
    CASE WHEN account_id_nullable = 'NO' AND profile_account_null = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('is_nullable=%s, linhas NULL=%s', account_id_nullable, profile_account_null) FROM m
  UNION ALL
  SELECT 4, 'profiles sem account órfã',
    CASE WHEN profile_orphans = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('órfãos=%s', profile_orphans) FROM m
  UNION ALL
  SELECT 5, 'account_members ausente',
    CASE WHEN account_members_absent THEN 'OK' ELSE 'BLOQUEANTE' END,
    CASE WHEN account_members_absent THEN 'nenhuma tabela de membership existe'
         ELSE 'EXISTE tabela de membership — auditoria desatualizada, documentar schema (bloco 3)' END FROM m
  UNION ALL
  SELECT 6, 'account_role_enum conhecido',
    CASE WHEN enum_values = 'admin,agent,owner,viewer' THEN 'OK' ELSE 'ATENÇÃO' END,
    format('valores=%s', enum_values) FROM m
  UNION ALL
  SELECT 7, 'owners consistentes (owner_user_id ↔ profile owner da mesma account)',
    CASE WHEN owner_inconsistent = 0 AND extra_owner_profiles = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('accounts com owner inconsistente=%s, profiles owner extras=%s (detalhe no bloco 11)',
           owner_inconsistent, extra_owner_profiles) FROM m
  UNION ALL
  SELECT 8, 'FKs para profiles = só as 3 conhecidas',
    CASE WHEN fk_source_tables = 'internal_team_members, queue_members, user_permission_overrides' THEN 'OK'
         ELSE 'ATENÇÃO' END,
    format('%s FK(s): %s', fks_to_profiles, coalesce(fk_source_tables, '—')) FROM m
  UNION ALL
  SELECT 9, 'sem dados dependentes órfãos',
    CASE WHEN dependent_orphans = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('órfãos em queue_members+overrides+internal_team_members=%s', dependent_orphans) FROM m
  UNION ALL
  SELECT 10, 'preview de backfill sem duplicatas nem NULLs',
    CASE WHEN backfill_duplicates = 0 AND backfill_nulls = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('memberships=%s, duplicatas=%s, linhas com NULL=%s', total_profiles, backfill_duplicates, backfill_nulls) FROM m
  UNION ALL
  SELECT 11, 'auth.users ↔ profiles consistente',
    CASE WHEN auth_without_profile = 0 AND profile_without_auth = 0 THEN 'OK' ELSE 'ATENÇÃO' END,
    format('auth sem profile=%s, profile sem auth=%s', auth_without_profile, profile_without_auth) FROM m
  UNION ALL
  SELECT 12, 'sem e-mails duplicados no auth (ninguém com 2 logins mesmo e-mail)',
    CASE WHEN duplicate_emails = 0 THEN 'OK' ELSE 'ATENÇÃO' END,
    format('e-mails duplicados (case-insensitive)=%s', duplicate_emails) FROM m
  UNION ALL
  SELECT 13, 'business_units / user_business_units ausentes',
    CASE WHEN business_units_absent AND business_unit_id_columns = 0 THEN 'OK' ELSE 'BLOQUEANTE' END,
    format('tabelas ausentes=%s, colunas business_unit_id=%s', business_units_absent, business_unit_id_columns) FROM m
  UNION ALL
  SELECT 14, 'idx_accounts_one_per_owner (dono de várias empresas)',
    CASE WHEN one_per_owner_index THEN 'ATENÇÃO' ELSE 'OK' END,
    CASE WHEN one_per_owner_index
         THEN 'presente — não bloqueia MU-1; relaxar na MU-4 se um usuário for DONO de >1 empresa'
         ELSE 'ausente' END FROM m
  UNION ALL
  SELECT 15, 'policies dependentes de is_account_member (contexto)',
    'OK',
    format('%s policies usam is_account_member; %s leem profiles diretamente (revisar na MU-2+)',
           policies_using_helper, policies_reading_profiles) FROM m
) r
ORDER BY ord;
