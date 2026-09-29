-- ============================================================
-- 071_account_feature_flags_structural_check.sql
--
-- Verificação ESTRUTURAL pura (schema/catálogo/privilégios) da
-- migration 071 — NÃO é uma migration, não é aplicada
-- automaticamente por nenhum runner. Toda query aqui é somente
-- leitura (introspecção via information_schema/pg_catalog e as
-- funções has_*_privilege()) — zero efeito colateral, SEGURA em
-- qualquer ambiente, inclusive produção. Não precisa de
-- BEGIN/ROLLBACK porque nada aqui escreve.
--
-- Rodar DEPOIS de aplicar 071. Cada bloco está numerado para bater
-- com os 21 itens da Parte 4 da revisão (Etapa Piloto 0.1).
-- Comportamental (dados sintéticos, escrita) fica em
-- 071_account_feature_flags_check.sql — Seção 2 daquele arquivo,
-- classificada B/C (não rodar em produção).
-- ============================================================

-- 1) a tabela existe
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'account_feature_flags'
) AS table_exists;

-- 2) colunas e tipos corretos (+ cobre o item 7: DEFAULT de `enabled`)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'account_feature_flags'
ORDER BY ordinal_position;
-- Esperado: id(uuid,NO,gen_random_uuid()), account_id(uuid,NO,—),
-- feature_key(text,NO,—), enabled(boolean,NO,false),
-- updated_by(uuid,YES,—), created_at(timestamptz,NO,now()),
-- updated_at(timestamptz,NO,now()).

-- 3) PK/UNIQUE corretos
SELECT tc.constraint_type, tc.constraint_name,
       string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public' AND tc.table_name = 'account_feature_flags'
  AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
GROUP BY tc.constraint_type, tc.constraint_name;
-- Esperado: PRIMARY KEY em (id); UNIQUE em (account_id, feature_key).

-- 4/5) FKs de account_id e updated_by, com a regra de delete correta
SELECT
  tc.constraint_name,
  kcu.column_name,
  ccu.table_schema  AS foreign_table_schema,
  ccu.table_name    AS foreign_table_name,
  ccu.column_name   AS foreign_column_name,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public' AND tc.table_name = 'account_feature_flags'
  AND tc.constraint_type = 'FOREIGN KEY';
-- Esperado: account_id -> public.accounts.id (delete_rule=CASCADE);
-- updated_by -> auth.users.id (delete_rule=SET NULL).

-- 6) CHECK de feature_key contém só as duas chaves esperadas
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.account_feature_flags'::regclass AND contype = 'c';
-- Esperado: definition menciona exatamente
-- 'multi_connection_enabled' e 'business_units_enabled', nada mais.

-- 8) trigger de updated_at existe e está habilitado
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.account_feature_flags'::regclass AND NOT tgisinternal;
-- Esperado: 1 linha, tgname='set_updated_at', tgenabled='O' (origin,
-- ou seja, ativo), BEFORE UPDATE, EXECUTE FUNCTION update_updated_at_column().

-- 9) RLS habilitada na tabela
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid = 'public.account_feature_flags'::regclass;
-- Esperado: relrowsecurity = true.

-- 10) policies existentes na tabela — esperado ZERO
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'account_feature_flags';
-- Esperado: 0 linhas.

-- 11) owner da tabela
SELECT tableowner FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'account_feature_flags';
-- Esperado: postgres (dono padrão de toda tabela criada pelas migrations).

-- 12) privilégios diretos concedidos na tabela, por role
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'account_feature_flags'
ORDER BY grantee, privilege_type;
-- Esperado: NENHUMA linha para PUBLIC/anon/authenticated. Pode haver
-- linhas para postgres/service_role — privilégio de plataforma do
-- Supabase, não concedido por esta migration (ela só faz REVOKE, nunca
-- GRANT nesta tabela).

-- 13) a função existe
SELECT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature'
) AS function_exists;

-- 14) assinatura correta + 21) nenhuma sobrecarga/duplicata
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  count(*) OVER () AS total_overloads
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: exatamente 1 linha. arguments = 'p_account_id uuid,
-- p_feature_key text, p_enabled boolean', returns = 'void',
-- total_overloads = 1 (nenhuma assinatura antiga/duplicada).

-- 15) SECURITY DEFINER = true
-- 16) search_path correto
-- 17) owner da função
SELECT
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname   AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: is_security_definer = true, config = {search_path=public},
-- owner = postgres.

-- 18/19/20) EXECUTE por role
SELECT
  has_function_privilege('PUBLIC', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')        AS public_can_execute,
  has_function_privilege('anon', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')  AS service_role_can_execute,
  has_function_privilege('postgres', 'public.platform_set_account_feature(uuid,text,boolean)', 'EXECUTE')      AS postgres_can_execute;
-- Esperado: public_can_execute=false, anon_can_execute=false,
-- authenticated_can_execute=true. service_role_can_execute e
-- postgres_can_execute dependem de privilégio padrão de PLATAFORMA do
-- Supabase (não concedido por esta migration, que nunca faz GRANT
-- para service_role/postgres) — normalmente ambos true por herança
-- de owner/role administrativa do projeto; se aparecer false para
-- service_role, isso é uma configuração do projeto Supabase, não algo
-- a "corrigir" nesta migration (nenhum caminho legítimo do produto
-- chama esta RPC como service_role — sempre como authenticated, via
-- o client RLS-scoped, mesmo padrão de platform_set_account_active).
