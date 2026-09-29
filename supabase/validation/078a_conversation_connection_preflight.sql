-- ============================================================
-- 078a_conversation_connection_preflight.sql
--
-- Verificação SOMENTE LEITURA — segura em produção. Roda ANTES de
-- aplicar supabase/migrations/078_conversation_connection_tracking.sql.
-- Nenhum INSERT/UPDATE/DELETE/DDL. Nenhum dado sintético.
--
-- Cada bloco traz o resultado esperado. Qualquer divergência nos
-- blocos marcados [BLOQUEANTE] deve interromper a aplicação da 078.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Ambiente
-- ------------------------------------------------------------

SELECT current_setting('server_version') AS server_version;
-- Informativo. A 078A não depende de PG15+ (não usa NULLS NOT
-- DISTINCT nem ON DELETE SET NULL (col)).

-- ------------------------------------------------------------
-- 1. Colunas de conversations
-- ------------------------------------------------------------

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations'
ORDER BY ordinal_position;
-- Esperado: id, user_id, contact_id, status, assigned_agent_id,
-- last_message_text, last_message_at, unread_count, created_at,
-- updated_at, account_id, ai_autoreply_disabled, ai_reply_count,
-- ai_handoff_summary, queue_id.

-- [BLOQUEANTE] whatsapp_config_id ainda NÃO existe
SELECT count(*) AS should_be_zero
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations'
  AND column_name = 'whatsapp_config_id';
-- Esperado: 0. (Se 1: a 078 já foi aplicada, total ou parcialmente —
-- rodar o check 078a_conversation_connection_check.sql em vez disto.)

-- ------------------------------------------------------------
-- 2. [BLOQUEANTE] idx_conversations_account_contact existe e é UNIQUE
-- ------------------------------------------------------------

SELECT i.relname AS index_name, ix.indisunique, pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = 'public.conversations'::regclass
ORDER BY i.relname;
-- Esperado: idx_conversations_account_contact com indisunique = true,
-- definição "(account_id, contact_id)" sem WHERE. Também:
-- conversations_pkey, idx_conversations_user_id,
-- idx_conversations_contact_id, idx_conversations_account,
-- idx_conversations_account_queue (parcial). Nenhum
-- idx_conversations_whatsapp_config / idx_conversations_account_contact_config ainda.

-- ------------------------------------------------------------
-- 3/4/5. whatsapp_config: PK em id, account_id NOT NULL,
--        nenhuma UNIQUE(id, account_id) ainda
-- ------------------------------------------------------------

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
ORDER BY contype, conname;
-- Esperado: whatsapp_config_pkey = PRIMARY KEY (id);
-- whatsapp_config_phone_number_id_key = UNIQUE (phone_number_id);
-- whatsapp_config_status_check; FKs de user_id/account_id/default_queue_id.
-- whatsapp_config_account_id_key NÃO deve aparecer (077 aplicada).

-- [BLOQUEANTE] nome que a 078 vai criar ainda livre, e nenhuma
-- UNIQUE equivalente com outro nome
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
  AND (
    conname = 'whatsapp_config_id_account_key'
    OR (contype = 'u' AND pg_get_constraintdef(oid) ILIKE '%(id, account_id)%')
  );
-- Esperado: 0 linhas.

-- [BLOQUEANTE] account_id NOT NULL
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
  AND column_name IN ('id', 'account_id');
-- Esperado: id NO, account_id NO.

-- [BLOQUEANTE] nomes que a 078 vai criar em conversations ainda livres
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.conversations'::regclass
  AND conname = 'conversations_whatsapp_config_account_fkey'
UNION ALL
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_conversations_whatsapp_config', 'idx_conversations_account_contact_config');
-- Esperado: 0 linhas.

-- ------------------------------------------------------------
-- 6. RLS de conversations
-- ------------------------------------------------------------

SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.conversations'::regclass;
-- Esperado: relrowsecurity = true.

-- ------------------------------------------------------------
-- 7. Policies atuais (linha de base para comparar no check pós-078)
-- ------------------------------------------------------------

SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: conversations_insert (017), conversations_select (059),
-- conversations_update (076). SEM conversations_delete (075).
-- A 078 NÃO altera nenhuma policy — salvar este resultado.

-- ------------------------------------------------------------
-- 8. Triggers atuais + definição vigente da função de 076
-- ------------------------------------------------------------

SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns (076, BEFORE UPDATE, sem lista
-- de colunas), on_conversation_assigned (027), set_updated_at (001),
-- validate_queue_tenancy (058).

SELECT pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure) AS current_definition;
-- Esperado: corpo idêntico ao da 076 (account_id, queue_id,
-- contact_id, user_id, created_at, unread_count; current_user =
-- 'authenticated'; ERRCODE insufficient_privilege). Se divergir,
-- PARAR — a 078 faz CREATE OR REPLACE a partir do corpo da 076.

SELECT p.proname, p.prosecdef AS security_definer,
       array_to_string(p.proacl, ', ') AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'conversations_enforce_privilege_columns';
-- Esperado: security_definer = false; ACL sem EXECUTE para
-- PUBLIC/anon/authenticated/service_role (076).

-- Contexto: triggers de whatsapp_config (não alterados pela 078)
SELECT tgname, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.whatsapp_config'::regclass AND NOT tgisinternal
ORDER BY tgname;

-- ------------------------------------------------------------
-- 9. Conversations por account
-- ------------------------------------------------------------

SELECT count(*) AS total_conversations,
       count(DISTINCT account_id) AS accounts_with_conversations
FROM public.conversations;

SELECT account_id, count(*) AS conversations
FROM public.conversations
GROUP BY account_id
ORDER BY conversations DESC;

-- Sanidade: a UNIQUE atual garante 0 duplicatas por (account, contact)
SELECT count(*) AS should_be_zero
FROM (
  SELECT 1 FROM public.conversations
  GROUP BY account_id, contact_id HAVING count(*) > 1
) d;
-- Esperado: 0.

-- ------------------------------------------------------------
-- 10/11/12. Accounts por número de whatsapp_config
-- ------------------------------------------------------------

WITH cfg AS (
  SELECT a.id AS account_id, count(w.id) AS configs
  FROM public.accounts a
  LEFT JOIN public.whatsapp_config w ON w.account_id = a.id
  GROUP BY a.id
)
SELECT CASE WHEN configs = 0 THEN '0 configs'
            WHEN configs = 1 THEN 'exactly 1 config'
            ELSE '>1 configs' END AS bucket,
       count(*) AS accounts
FROM cfg
GROUP BY 1
ORDER BY 1;

-- Detalhe das accounts com >1 config (esperado: 0 linhas, a menos que
-- alguém tenha criado uma 2ª conexão entre a 077 e a 078-0).
SELECT w.account_id, w.id AS config_id, w.provider, w.status, w.created_at
FROM public.whatsapp_config w
WHERE w.account_id IN (
  SELECT account_id FROM public.whatsapp_config
  GROUP BY account_id HAVING count(*) > 1
)
ORDER BY w.account_id, w.created_at;
-- Se houver linhas: a 078 NÃO preenche conversations dessas accounts
-- (ficam NULL). Registrar para tratamento manual (grupo 2/3 da
-- auditoria 078).

-- ------------------------------------------------------------
-- 13. Volume do backfill determinístico
-- ------------------------------------------------------------

WITH single_config AS (
  SELECT account_id FROM public.whatsapp_config
  GROUP BY account_id HAVING count(*) = 1
)
SELECT
  count(*) FILTER (WHERE c.account_id IN (SELECT account_id FROM single_config)) AS will_be_backfilled,
  count(*) FILTER (WHERE c.account_id NOT IN (SELECT account_id FROM single_config)) AS will_stay_null,
  count(*) AS total
FROM public.conversations c;
-- will_be_backfilled = linhas que o UPDATE da 078 vai tocar. Cada uma
-- gera um evento realtime (conversations está em supabase_realtime) —
-- ver "impacto operacional" no cabeçalho da migration.

-- Conversations que ficarão NULL, por motivo
WITH cfg AS (
  SELECT account_id, count(*) AS configs FROM public.whatsapp_config GROUP BY account_id
)
SELECT CASE WHEN cfg.configs IS NULL THEN 'account sem config'
            ELSE 'account com >1 config' END AS reason,
       count(*) AS conversations
FROM public.conversations c
LEFT JOIN cfg ON cfg.account_id = c.account_id
WHERE cfg.configs IS DISTINCT FROM 1
GROUP BY 1;

-- ------------------------------------------------------------
-- 14. Impacto do FK NO ACTION no delete de whatsapp_config
-- ------------------------------------------------------------

-- Configs que, após o backfill, passarão a ter conversations
-- referenciando-as — hard delete delas (Reset Configuration,
-- DELETE /api/uazapi/instance sem credenciais Meta, "Recriar
-- instância") passa a falhar com 23503 até a 078E.
WITH single_config AS (
  SELECT account_id, (array_agg(id))[1] AS config_id
  FROM public.whatsapp_config
  GROUP BY account_id HAVING count(*) = 1
)
SELECT s.config_id, w.provider, w.status, count(c.id) AS conversations_that_will_reference_it
FROM single_config s
JOIN public.whatsapp_config w ON w.id = s.config_id
JOIN public.conversations c ON c.account_id = s.account_id
GROUP BY s.config_id, w.provider, w.status
ORDER BY conversations_that_will_reference_it DESC;

-- ------------------------------------------------------------
-- 15. Contexto: realtime + dependência de feature flags (071)
-- ------------------------------------------------------------

SELECT pubname, tablename
FROM pg_publication_tables
WHERE tablename IN ('conversations', 'whatsapp_config');
-- Esperado: supabase_realtime / conversations.

SELECT to_regclass('public.account_feature_flags') IS NOT NULL AS feature_flags_table_exists;
-- Informativo: a 078 NÃO depende da 071. O gate 078-0 (aplicação)
-- é fail-closed mesmo sem a tabela.
