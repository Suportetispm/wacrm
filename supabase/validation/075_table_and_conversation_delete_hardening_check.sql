-- ============================================================
-- 075_table_and_conversation_delete_hardening_check.sql
--
-- Verificação SOMENTE LEITURA da migration 075 — segura em qualquer
-- ambiente, inclusive produção. Nenhuma escrita, nenhum
-- BEGIN/ROLLBACK necessário.
-- ============================================================

-- ============================================================
-- user_permission_overrides
-- ============================================================

-- RLS continua habilitada
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.user_permission_overrides'::regclass;
-- Esperado: relrowsecurity = true.

-- Zero policies (continua, 075 não cria nenhuma)
SELECT count(*) AS policy_count
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'user_permission_overrides';
-- Esperado: 0.

-- PUBLIC/anon/authenticated sem privilégio de tabela — via aclexplode
-- (grantee=0 = PUBLIC), evita o erro de has_table_privilege('PUBLIC',...)
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
WHERE c.oid = 'public.user_permission_overrides'::regclass
ORDER BY grantee, acl.privilege_type;
-- Esperado: NENHUMA linha para PUBLIC/anon/authenticated. Pode haver
-- linhas para service_role/postgres (privilégio de plataforma do
-- Supabase, não concedido por 075 — a migration só REVOGA, nunca
-- GRANTa nesta tabela).

-- Resumo booleano rápido, mesmo conjunto de roles do padrão já usado
-- em 072/073/074 (has_table_privilege funciona normalmente para
-- roles reais, só PUBLIC precisa de aclexplode)
SELECT
  has_table_privilege('anon', 'public.user_permission_overrides', 'SELECT')          AS anon_select,
  has_table_privilege('anon', 'public.user_permission_overrides', 'INSERT')          AS anon_insert,
  has_table_privilege('authenticated', 'public.user_permission_overrides', 'SELECT') AS authenticated_select,
  has_table_privilege('authenticated', 'public.user_permission_overrides', 'INSERT') AS authenticated_insert,
  has_table_privilege('service_role', 'public.user_permission_overrides', 'SELECT')  AS service_role_select,
  has_table_privilege('service_role', 'public.user_permission_overrides', 'INSERT')  AS service_role_insert;
-- Esperado: anon/authenticated tudo false. service_role: reportar sem
-- exigir valor específico (não é alvo desta migration, mas costuma
-- ser true por privilégio de plataforma do Supabase, e é o caminho
-- legítimo de src/lib/permissions/store.ts).

-- ============================================================
-- conversations — policies
-- ============================================================

-- conversations_delete NÃO existe mais
SELECT count(*) AS conversations_delete_policy_count
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'conversations_delete';
-- Esperado: 0.

-- conversations_insert continua existindo e INALTERADA (mesma
-- condição de 017 — 075 não toca aqui)
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'conversations_insert';
-- Esperado: 1 linha, with_check menciona is_account_member(account_id, 'agent').

-- conversations_update continua existindo e INALTERADA (mesma
-- condição de 017 — fica para a migration 076)
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'conversations_update';
-- Esperado: 1 linha, qual menciona is_account_member(account_id, 'agent')
-- (ainda sem checagem de fila/atribuição — 076 vai tratar isso).

-- conversations_select continua existindo e INALTERADA (vigente
-- desde 059 — 075 não toca aqui)
SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'conversations_select';
-- Esperado: 1 linha, qual = exatamente a condição de 059 (admin vê
-- tudo; agent/viewer restritos a assigned_agent_id/queue_members ativo).

-- Visão consolidada: todas as policies de conversations, de uma vez
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: exatamente 3 linhas — conversations_insert,
-- conversations_select, conversations_update. Nenhuma
-- conversations_delete.

-- Confirma que nenhuma OUTRA tabela teve policy alterada por engano
-- (controle negativo rápido — conta total de policies no schema não
-- deveria ter mudado além do -1 esperado de conversations_delete)
SELECT count(*) AS total_policies_in_public_schema
FROM pg_policies WHERE schemaname = 'public';
-- Comparar manualmente com a contagem de ANTES de aplicar 075 —
-- deve ser exatamente 1 a menos.
