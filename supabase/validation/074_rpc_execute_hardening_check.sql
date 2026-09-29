-- ============================================================
-- 074_rpc_execute_hardening_check.sql
--
-- Verificação SOMENTE LEITURA da migration 074 — segura em qualquer
-- ambiente, inclusive produção. Nenhuma escrita, nenhum
-- BEGIN/ROLLBACK necessário.
--
-- Cobre as 12 funções efetivamente alteradas por 074 (Grupos A, B, C
-- da migration) + confirma que account_has_any_data (excluída de
-- propósito) permanece com zero grants, e que nenhuma outra função
-- fora da lista foi tocada.
--
-- NOTA SOBRE PUBLIC: mesma técnica de 072/073 — aclexplode() com
-- grantee=0, nunca has_function_privilege('PUBLIC', ...).
-- ============================================================

WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.merge_duplicate_contacts()'),
    ('public.merge_duplicate_conversations()'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])'),
    ('public.set_member_role(uuid,account_role_enum)'),
    ('public.remove_account_member(uuid)'),
    ('public.transfer_account_ownership(uuid)'),
    ('public.mark_ticket_waiting_customer(uuid)'),
    ('public.resume_ticket(uuid)'),
    ('public.close_ticket(uuid,text,boolean)'),
    ('public.touch_presence(text)'),
    ('public.is_account_member(uuid,account_role_enum)')
)
-- 1) as 12 funções existem
SELECT tf.qualified_signature, (tf.qualified_signature::regprocedure) IS NOT NULL AS function_exists
FROM target_functions tf;

-- 2) assinatura + 3) overloads esperados (1 cada)
SELECT p.proname, count(*) AS overload_count,
       string_agg(pg_get_function_identity_arguments(p.oid), ' | ' ORDER BY p.oid) AS all_argument_lists
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'merge_duplicate_contacts', 'merge_duplicate_conversations',
    'platform_attach_user_to_account', 'platform_update_user',
    'set_member_role', 'remove_account_member', 'transfer_account_ownership',
    'mark_ticket_waiting_customer', 'resume_ticket', 'close_ticket',
    'touch_presence', 'is_account_member'
  )
GROUP BY p.proname ORDER BY p.proname;
-- Esperado: overload_count=1 em todas as 12.

-- 4) SECURITY DEFINER permanece igual + 5) search_path permanece
--    igual + 6) owner permanece igual (074 não recria nenhuma função)
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.merge_duplicate_contacts()'),
    ('public.merge_duplicate_conversations()'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])'),
    ('public.set_member_role(uuid,account_role_enum)'),
    ('public.remove_account_member(uuid)'),
    ('public.transfer_account_ownership(uuid)'),
    ('public.mark_ticket_waiting_customer(uuid)'),
    ('public.resume_ticket(uuid)'),
    ('public.close_ticket(uuid,text,boolean)'),
    ('public.touch_presence(text)'),
    ('public.is_account_member(uuid,account_role_enum)')
)
SELECT tf.qualified_signature, p.prosecdef AS is_security_definer, p.proconfig AS config, r.rolname AS owner
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
JOIN pg_roles r ON r.oid = p.proowner
ORDER BY tf.qualified_signature;
-- Esperado: is_security_definer=true em todas, owner=postgres em
-- todas. Comparar search_path com o preflight (074_platform_rpc_
-- preflight_check.sql) rodado ANTES de aplicar — devem ser idênticos
-- (074 não altera corpo/search_path de nenhuma função).

-- 7) PUBLIC sem EXECUTE + 8) anon sem EXECUTE + 9) roles legítimas
--    continuam com EXECUTE + 10) service_role/postgres reportados
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.merge_duplicate_contacts()'),
    ('public.merge_duplicate_conversations()'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])'),
    ('public.set_member_role(uuid,account_role_enum)'),
    ('public.remove_account_member(uuid)'),
    ('public.transfer_account_ownership(uuid)'),
    ('public.mark_ticket_waiting_customer(uuid)'),
    ('public.resume_ticket(uuid)'),
    ('public.close_ticket(uuid,text,boolean)'),
    ('public.touch_presence(text)'),
    ('public.is_account_member(uuid,account_role_enum)')
)
SELECT
  tf.qualified_signature,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
ORDER BY tf.qualified_signature, grantee, acl.privilege_type;
-- Esperado por função:
--   merge_duplicate_contacts / merge_duplicate_conversations: NENHUMA
--     linha de EXECUTE para nenhum grantee de cliente (nem PUBLIC,
--     nem anon, nem authenticated) — só postgres/service_role podem
--     aparecer, se o privilégio de plataforma do Supabase os cobrir.
--   as outras 9 (platform_attach_user_to_account, platform_update_user,
--     set_member_role, remove_account_member, transfer_account_ownership,
--     mark_ticket_waiting_customer, resume_ticket, close_ticket,
--     touch_presence): sem PUBLIC, sem anon; EXATAMENTE 1 linha
--     authenticated/EXECUTE.
--   is_account_member: sem PUBLIC, sem anon; linhas authenticated/
--     EXECUTE e service_role/EXECUTE (as duas, como já era antes).

-- Resumo booleano rápido (mais fácil de conferir que a tabela acima)
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.merge_duplicate_contacts()'),
    ('public.merge_duplicate_conversations()'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])'),
    ('public.set_member_role(uuid,account_role_enum)'),
    ('public.remove_account_member(uuid)'),
    ('public.transfer_account_ownership(uuid)'),
    ('public.mark_ticket_waiting_customer(uuid)'),
    ('public.resume_ticket(uuid)'),
    ('public.close_ticket(uuid,text,boolean)'),
    ('public.touch_presence(text)'),
    ('public.is_account_member(uuid,account_role_enum)')
)
SELECT
  tf.qualified_signature,
  NOT EXISTS (
    SELECT 1 FROM pg_proc p2
    CROSS JOIN LATERAL aclexplode(COALESCE(p2.proacl, acldefault('f', p2.proowner))) AS acl2
    WHERE p2.oid = tf.qualified_signature::regprocedure
      AND acl2.grantee = 0 AND acl2.privilege_type = 'EXECUTE'
  ) AS public_has_no_execute,
  has_function_privilege('anon', tf.qualified_signature, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', tf.qualified_signature, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', tf.qualified_signature, 'EXECUTE') AS service_role_can_execute,
  has_function_privilege('postgres', tf.qualified_signature, 'EXECUTE') AS postgres_can_execute
FROM target_functions tf
ORDER BY tf.qualified_signature;
-- Esperado: public_has_no_execute=true e anon_can_execute=false em
-- TODAS as 12. authenticated_can_execute=true para as 10 do Grupo
-- B+C (todas exceto as 2 merge_*); authenticated_can_execute=false
-- para as 2 merge_* (não receberam GRANT nenhum). service_role/
-- postgres: reportar sem exigir valor específico.

-- 11) nenhuma função FORA da lista foi alterada — controle negativo:
--     account_has_any_data continua com ZERO grants para QUALQUER
--     role (074 não a toca; ela já estava assim desde 055)
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
WHERE p.oid = 'public.account_has_any_data(uuid)'::regprocedure;
-- Esperado: ZERO linhas (nem para service_role/postgres — 055 revogou
-- de todo mundo, inclusive service_role). Se aparecer qualquer linha,
-- algo mudou fora desta migration — investigar separadamente, não é
-- efeito de 074.

-- 12) account_feature_flags continua no estado anterior (074 não
--     escreve nela — confirmação de não-efeito-colateral)
SELECT count(*) AS account_feature_flags_row_count FROM public.account_feature_flags;
