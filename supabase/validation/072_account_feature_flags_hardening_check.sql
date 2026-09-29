-- ============================================================
-- 072_account_feature_flags_hardening_check.sql
--
-- Verificação SOMENTE LEITURA da migration 072 — segura em qualquer
-- ambiente, inclusive produção. Nenhuma escrita, nenhum
-- BEGIN/ROLLBACK necessário.
--
-- NOTA SOBRE PUBLIC: has_function_privilege('PUBLIC', ...) FALHA
-- neste projeto com "ERROR 42704: role "PUBLIC" does not exist" —
-- PUBLIC é um pseudo-role reservado do Postgres, não uma linha real
-- em pg_roles, e has_function_privilege() exige um role de verdade
-- como primeiro argumento. Por isso o status de PUBLIC é obtido por
-- introspecção direta de ACL (pg_proc.proacl via aclexplode()), onde
-- PUBLIC aparece como grantee = 0 — não por has_function_privilege().
-- Para anon/authenticated/service_role/postgres (roles reais),
-- has_function_privilege() funciona normalmente.
-- ============================================================

-- 1) a função continua existindo
SELECT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature'
) AS function_exists;

-- 2) assinatura continua única (nenhuma sobrecarga/duplicata)
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  count(*) OVER () AS total_overloads
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: exatamente 1 linha, total_overloads = 1.

-- 3) SECURITY DEFINER continua true
-- 4) search_path continua correto
-- 5) owner continua postgres
SELECT
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname   AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: is_security_definer = true, config = {search_path=public},
-- owner = postgres. (Confirma que 072 não recriou nem alterou a
-- função — corpo, SECURITY DEFINER e search_path são idênticos aos
-- de 071.)

-- 6/7/8) ACL completa da função, via aclexplode — mostra TODOS os
-- grantees e privilégios de uma vez, incluindo PUBLIC (grantee = 0),
-- sem usar has_function_privilege('PUBLIC', ...) (que erroria).
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature'
ORDER BY grantee, acl.privilege_type;
-- Esperado após 072: NENHUMA linha com grantee='PUBLIC' e
-- privilege_type='EXECUTE'; NENHUMA linha com grantee='anon' e
-- privilege_type='EXECUTE'; UMA linha grantee='authenticated',
-- privilege_type='EXECUTE'. service_role/postgres podem ou não
-- aparecer (não são tocados por 072 — ver item 9).

-- 6) confirmação direta e objetiva: PUBLIC sem EXECUTE (boolean único,
-- fácil de checar sem interpretar a tabela acima)
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  WHERE n.nspname = 'public'
    AND p.proname = 'platform_set_account_feature'
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
) AS public_has_no_execute;
-- Esperado: true.

-- 7) anon sem EXECUTE — objetivo desta migration
-- 8) authenticated com EXECUTE — nunca deveria ter sido perdido
-- 9) service_role/postgres — apenas reportados, sem expectativa fixa
--    (não são alvo desta migration; ambos são caminhos
--    administrativos/server-only por construção do projeto)
SELECT
  has_function_privilege('anon', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')  AS service_role_can_execute,
  has_function_privilege('postgres', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')      AS postgres_can_execute;
-- Esperado: anon_can_execute = false, authenticated_can_execute = true.
-- service_role_can_execute / postgres_can_execute: reportar o valor,
-- sem exigir um resultado específico (ver comentário acima).

-- 10) account_feature_flags continua com 0 linhas — nenhuma feature
--     foi ativada em nenhum momento (nem antes, nem depois de 072;
--     esta migration não escreve na tabela, só ajusta grants da RPC)
SELECT count(*) AS account_feature_flags_row_count
FROM public.account_feature_flags;
-- Esperado: 0. Se vier diferente de 0, PARE — significa que alguma
-- flag foi ativada em algum momento entre 071 e agora, o que está
-- fora do escopo desta migration e precisa ser investigado
-- separadamente antes de prosseguir (quem ativou, quando, via qual
-- caminho — platform_audit_log tem o histórico).

-- ============================================================
-- DIAGNÓSTICO OPCIONAL (não necessário para validar 072, só para
-- confirmar a causa-raiz hipotetizada no cabeçalho da migration) —
-- mostra as regras de privilégio DEFAULT do schema public, se
-- existirem. Se aparecer uma linha com defaclobjtype='f' (functions)
-- concedendo a anon, essa é a causa confirmada: toda função nova
-- criada em public recebe EXECUTE para anon automaticamente no
-- momento do CREATE FUNCTION, antes de qualquer REVOKE subsequente
-- na mesma migration.
-- ============================================================
SELECT
  n.nspname AS schema,
  d.defaclrole::regrole::text AS default_for_role,
  d.defaclobjtype AS object_type,
  d.defaclacl AS default_acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';
