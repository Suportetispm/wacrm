-- ============================================================
-- 076_conversations_update_preflight_check.sql
--
-- Verificação SOMENTE LEITURA — segura em produção. Roda ANTES de
-- decidir/aplicar 076.
-- ============================================================

-- Definição atual de conversations_select e conversations_update lado a lado
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: conversations_insert, conversations_select,
-- conversations_update (conversations_delete não deve existir — 075
-- já aplicada). select deve mostrar a condição de 059
-- (assigned_agent_id/queue_members); update ainda deve mostrar só
-- is_account_member(account_id,'agent') (017) — é exatamente isso
-- que 076 vai mudar.

-- RLS habilitada
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.conversations'::regclass;

-- Grants de tabela (contexto — não alterados por 076)
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'conversations'
ORDER BY grantee, privilege_type;

-- Triggers existentes em conversations (confirma o que já existe
-- antes de adicionar o novo)
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado hoje: validate_queue_tenancy (058) + set_updated_at (se
-- existir) + on_conversation_assigned (027, notificações). 076 vai
-- adicionar um novo: enforce_privilege_columns.

-- Constraints relevantes (FKs de queue_id/contact_id/account_id)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.conversations'::regclass
ORDER BY conname;

-- Colunas da tabela (confirma nomes exatos antes de escrever o
-- trigger — evita erro de digitação em produção)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations'
ORDER BY ordinal_position;

-- Column privileges (se existir algum REVOKE/GRANT de coluna já
-- aplicado por fora do histórico de migrations conhecido)
SELECT grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'conversations'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, column_name, privilege_type;
-- Esperado: sem restrição de coluna hoje (RLS de linha é o único
-- mecanismo vigente) — 076 não usa REVOKE de coluna, usa trigger,
-- mas esta query serve de linha de base para confirmar que não há
-- nenhuma configuração de coluna pré-existente desconhecida.

-- Confirma zero authenticated writer histórico em queue_id/contact_id/
-- user_id/created_at/unread_count — via pg_stat não é confiável (reset
-- em restart), então esta é só uma checagem estrutural: confirma que
-- nenhuma policy atual já menciona essas colunas em WITH CHECK
-- (garantindo que 076 não está removendo algo que já existia).
SELECT policyname, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
  AND (with_check::text ILIKE '%queue_id%' OR with_check::text ILIKE '%contact_id%');
-- Esperado: 0 linhas (nenhuma policy hoje já protege essas colunas).
