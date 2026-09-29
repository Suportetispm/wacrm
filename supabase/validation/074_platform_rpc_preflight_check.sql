-- ============================================================
-- 074_platform_rpc_preflight_check.sql
--
-- Verificação SOMENTE LEITURA, segura em produção — roda ANTES de
-- decidir/aplicar a migration 074. Confirma contra o banco real o
-- que a auditoria de código já determinou a partir do histórico de
-- migrations, para as 12 funções candidatas a hardening + a 13ª
-- (`account_has_any_data`) como controle negativo (já deveria estar
-- totalmente travada desde a migration 055 — se este preflight
-- mostrar qualquer EXECUTE concedido a ela, PARE e investigue antes
-- de prosseguir, algo estaria diferente do esperado pelo código).
--
-- NOTA SOBRE PUBLIC: has_function_privilege('PUBLIC', ...) FALHA
-- neste projeto ("role "PUBLIC" does not exist"). Usa-se aclexplode()
-- com grantee=0 para PUBLIC, mesma técnica de 072/073.
-- ============================================================

WITH target_functions(qualified_signature, category) AS (
  VALUES
    -- A — CRÍTICA/ALTA (sem checagem de identidade, sem caller em src/)
    ('public.merge_duplicate_contacts()', 'A-critica'),
    ('public.merge_duplicate_conversations()', 'A-critica'),
    -- B — MÉDIA (checagem interna de auth.uid()/role presente, caller confirmado authenticated)
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])', 'B-media'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])', 'B-media'),
    ('public.set_member_role(uuid,account_role_enum)', 'B-media'),
    ('public.remove_account_member(uuid)', 'B-media'),
    ('public.transfer_account_ownership(uuid)', 'B-media'),
    ('public.mark_ticket_waiting_customer(uuid)', 'B-media'),
    ('public.resume_ticket(uuid)', 'B-media'),
    ('public.close_ticket(uuid,text,boolean)', 'B-media'),
    ('public.touch_presence(text)', 'B-media'),
    -- C — BAIXA (helper boolean, corpo seguro para anon, nunca teve REVOKE FROM PUBLIC)
    ('public.is_account_member(uuid,account_role_enum)', 'C-baixa'),
    -- D — CONTROLE NEGATIVO (já deveria estar 100% travada desde 055 — não deve entrar na 074)
    ('public.account_has_any_data(uuid)', 'D-ja-protegida-controle')
)
-- 1) existência + assinatura
SELECT
  tf.qualified_signature,
  tf.category,
  (tf.qualified_signature::regprocedure) IS NOT NULL AS function_exists
FROM target_functions tf;
-- Esperado: 13 linhas, function_exists=true em todas. Um erro de cast
-- aqui (em vez de false) já é sinal de assinatura divergente do
-- esperado — investigar antes de prosseguir.

-- 2) overloads por nome (detecta sobrecarga inesperada não coberta
--    pela assinatura exata acima)
SELECT
  p.proname,
  count(*) AS overload_count,
  string_agg(pg_get_function_identity_arguments(p.oid), ' | ' ORDER BY p.oid) AS all_argument_lists
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'merge_duplicate_contacts', 'merge_duplicate_conversations',
    'platform_attach_user_to_account', 'platform_update_user',
    'set_member_role', 'remove_account_member', 'transfer_account_ownership',
    'mark_ticket_waiting_customer', 'resume_ticket', 'close_ticket',
    'touch_presence', 'is_account_member', 'account_has_any_data'
  )
GROUP BY p.proname
ORDER BY p.proname;
-- Esperado: overload_count=1 em todas.

-- 3) SECURITY DEFINER + 4) search_path + 5) owner
WITH target_functions(qualified_signature, category) AS (
  VALUES
    ('public.merge_duplicate_contacts()', 'A-critica'),
    ('public.merge_duplicate_conversations()', 'A-critica'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])', 'B-media'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])', 'B-media'),
    ('public.set_member_role(uuid,account_role_enum)', 'B-media'),
    ('public.remove_account_member(uuid)', 'B-media'),
    ('public.transfer_account_ownership(uuid)', 'B-media'),
    ('public.mark_ticket_waiting_customer(uuid)', 'B-media'),
    ('public.resume_ticket(uuid)', 'B-media'),
    ('public.close_ticket(uuid,text,boolean)', 'B-media'),
    ('public.touch_presence(text)', 'B-media'),
    ('public.is_account_member(uuid,account_role_enum)', 'C-baixa'),
    ('public.account_has_any_data(uuid)', 'D-ja-protegida-controle')
)
SELECT
  tf.qualified_signature,
  tf.category,
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname AS owner
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
JOIN pg_roles r ON r.oid = p.proowner
ORDER BY tf.category, tf.qualified_signature;
-- Esperado: is_security_definer=true em todas as 13; owner=postgres
-- em todas; search_path=public em quase todas (touch_presence e
-- is_account_member podem não ter SET search_path explícito — o
-- código-fonte confirma que touch_presence TEM `SET search_path =
-- public`; is_account_member também tem. Se algum vier NULL/vazio
-- aqui, diverge do que o código-fonte mostra — investigar).

-- 6-10) ACL completa via aclexplode — PUBLIC(grantee=0)/anon/
--       authenticated/service_role/postgres, tudo de uma vez, para
--       as 13 funções
WITH target_functions(qualified_signature, category) AS (
  VALUES
    ('public.merge_duplicate_contacts()', 'A-critica'),
    ('public.merge_duplicate_conversations()', 'A-critica'),
    ('public.platform_attach_user_to_account(uuid,uuid,account_role_enum,text,uuid[])', 'B-media'),
    ('public.platform_update_user(uuid,text,account_role_enum,boolean,uuid[])', 'B-media'),
    ('public.set_member_role(uuid,account_role_enum)', 'B-media'),
    ('public.remove_account_member(uuid)', 'B-media'),
    ('public.transfer_account_ownership(uuid)', 'B-media'),
    ('public.mark_ticket_waiting_customer(uuid)', 'B-media'),
    ('public.resume_ticket(uuid)', 'B-media'),
    ('public.close_ticket(uuid,text,boolean)', 'B-media'),
    ('public.touch_presence(text)', 'B-media'),
    ('public.is_account_member(uuid,account_role_enum)', 'C-baixa'),
    ('public.account_has_any_data(uuid)', 'D-ja-protegida-controle')
)
SELECT
  tf.category,
  tf.qualified_signature,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM target_functions tf
JOIN pg_proc p ON p.oid = tf.qualified_signature::regprocedure
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
ORDER BY tf.category, tf.qualified_signature, grantee, acl.privilege_type;
-- LEITURA ESPERADA (o que confirmar antes de aplicar 074):
--   A-critica (merge_*): hoje sem GRANT a ninguém no código-fonte —
--     se aparecer EXECUTE para anon/authenticated aqui, confirma o
--     mesmo padrão de default privilege já provado; é exatamente o
--     que 074 vai fechar.
--   B-media: hoje GRANT authenticated no código — esperado ver
--     authenticated=EXECUTE; CONFIRMAR se anon também aparece (é o
--     que 074 vai revogar).
--   C-baixa (is_account_member): hoje GRANT authenticated,service_role
--     no código, SEM NUNCA ter revogado de PUBLIC — esperado ver
--     PUBLIC=EXECUTE aqui (não corrigido em nenhuma migration até
--     073); CONFIRMAR se anon também aparece.
--   D-controle (account_has_any_data): esperado ZERO linhas para
--     QUALQUER grantee (REVOKE ALL de PUBLIC/anon/authenticated/
--     service_role desde a migration 055) — se aparecer qualquer
--     linha aqui, PARE, é uma divergência real do esperado pelo
--     código-fonte e precisa de investigação antes de tocar em
--     qualquer outra função desta lista.

-- 11) estado de account_feature_flags — confirma que nada foi
--     ativado entre as etapas anteriores e agora (não relacionado às
--     12 funções, mas barato de checar de novo aqui)
SELECT count(*) AS account_feature_flags_row_count FROM public.account_feature_flags;
-- Esperado: 0 (a menos que você já tenha ativado o piloto deliberadamente).
