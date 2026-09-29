-- ============================================================
-- 073_platform_rpc_execute_hardening_check.sql
--
-- Verificação SOMENTE LEITURA da migration 073 — segura em qualquer
-- ambiente, inclusive produção. Nenhuma escrita, nenhum
-- BEGIN/ROLLBACK necessário.
--
-- Cobre as 5 RPCs de uma vez: grant_platform_admin(uuid),
-- revoke_platform_admin(uuid), platform_create_account(text,uuid),
-- platform_update_account(uuid,text),
-- platform_set_account_active(uuid,boolean).
--
-- NOTA SOBRE PUBLIC: has_function_privilege('PUBLIC', ...) FALHA
-- neste projeto ("ERROR 42704: role "PUBLIC" does not exist") — usa-se
-- introspecção direta de ACL (pg_proc.proacl via aclexplode()), onde
-- PUBLIC aparece como grantee = 0. Mesma técnica já usada em
-- 072_account_feature_flags_hardening_check.sql.
-- ============================================================

-- Lista das 5 assinaturas-alvo desta migration, usada como driver
-- para todas as queries abaixo — evita repetir os 5 nomes em cada
-- bloco e garante que todos cobrem exatamente o mesmo conjunto.
-- (Se um cast para regprocedure falhar aqui, a função não existe com
-- essa assinatura exata — a query inteira erroraria, o que já é um
-- sinal de alerta por si só.)

-- 1) as 5 funções existem
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.grant_platform_admin(uuid)'),
    ('public.revoke_platform_admin(uuid)'),
    ('public.platform_create_account(text,uuid)'),
    ('public.platform_update_account(uuid,text)'),
    ('public.platform_set_account_active(uuid,boolean)')
)
SELECT
  tf.qualified_signature,
  (tf.qualified_signature::regprocedure) IS NOT NULL AS function_exists
FROM target_functions tf;
-- Esperado: 5 linhas, function_exists = true em todas (um erro aqui
-- em vez de `false` também conta como "não existe com essa
-- assinatura" — investigar antes de prosseguir).

-- 2) assinatura + 3) overloads (por nome, não por assinatura exata —
--    detecta se alguma ganhou uma sobrecarga inesperada)
SELECT
  p.proname,
  count(*) AS overload_count,
  string_agg(pg_get_function_identity_arguments(p.oid), ' | ' ORDER BY p.oid) AS all_argument_lists
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'grant_platform_admin', 'revoke_platform_admin',
    'platform_create_account', 'platform_update_account',
    'platform_set_account_active'
  )
GROUP BY p.proname
ORDER BY p.proname;
-- Esperado: 5 linhas, overload_count = 1 em todas. Se algum
-- overload_count > 1, PARE — significa que existe uma sobrecarga não
-- prevista por esta migration, e o REVOKE/GRANT de 073 só afeta a
-- assinatura listada no item 1, não a(s) outra(s).

-- 4) SECURITY DEFINER + 5) search_path + 6) owner, para cada uma
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.grant_platform_admin(uuid)'),
    ('public.revoke_platform_admin(uuid)'),
    ('public.platform_create_account(text,uuid)'),
    ('public.platform_update_account(uuid,text)'),
    ('public.platform_set_account_active(uuid,boolean)')
)
SELECT
  tf.qualified_signature,
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname   AS owner
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
JOIN pg_roles r ON r.oid = p.proowner
ORDER BY tf.qualified_signature;
-- Esperado: is_security_definer = true, config = {search_path=public},
-- owner = postgres, nas 5 linhas — idêntico ao que já era antes de
-- 073 (confirma que 073 não alterou corpo/owner/search_path).

-- 7) PUBLIC sem EXECUTE em nenhuma das 5 (via aclexplode, grantee=0)
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.grant_platform_admin(uuid)'),
    ('public.revoke_platform_admin(uuid)'),
    ('public.platform_create_account(text,uuid)'),
    ('public.platform_update_account(uuid,text)'),
    ('public.platform_set_account_active(uuid,boolean)')
)
SELECT
  tf.qualified_signature,
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.oid = tf.qualified_signature::regprocedure
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) AS public_has_no_execute
FROM target_functions tf
ORDER BY tf.qualified_signature;
-- Esperado: public_has_no_execute = true nas 5 linhas.

-- 8) anon sem EXECUTE + 9) authenticated com EXECUTE + service_role/
--    postgres apenas reportados (sem expectativa fixa — não são alvo
--    desta migration)
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.grant_platform_admin(uuid)'),
    ('public.revoke_platform_admin(uuid)'),
    ('public.platform_create_account(text,uuid)'),
    ('public.platform_update_account(uuid,text)'),
    ('public.platform_set_account_active(uuid,boolean)')
)
SELECT
  tf.qualified_signature,
  has_function_privilege('anon', tf.qualified_signature, 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', tf.qualified_signature, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', tf.qualified_signature, 'EXECUTE')  AS service_role_can_execute,
  has_function_privilege('postgres', tf.qualified_signature, 'EXECUTE')      AS postgres_can_execute
FROM target_functions tf
ORDER BY tf.qualified_signature;
-- Esperado: anon_can_execute = false e authenticated_can_execute = true
-- nas 5 linhas. service_role/postgres: só reportar, sem exigir valor
-- específico (ver comentário do item acima).

-- 10) visão CONSOLIDADA da ACL completa das 5 funções, um grantee por
--     linha — útil para uma checagem visual rápida de tudo de uma vez
--     (equivalente a rodar aclexplode 5 vezes, mas numa tabela só)
WITH target_functions(qualified_signature) AS (
  VALUES
    ('public.grant_platform_admin(uuid)'),
    ('public.revoke_platform_admin(uuid)'),
    ('public.platform_create_account(text,uuid)'),
    ('public.platform_update_account(uuid,text)'),
    ('public.platform_set_account_active(uuid,boolean)')
)
SELECT
  tf.qualified_signature,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
ORDER BY tf.qualified_signature, grantee, acl.privilege_type;
-- Esperado: para cada uma das 5 assinaturas, nenhuma linha
-- grantee='PUBLIC' nem grantee='anon' com privilege_type='EXECUTE';
-- exatamente uma linha grantee='authenticated', privilege_type='EXECUTE'.
-- service_role/postgres podem ou não aparecer (não tocados por 073).
