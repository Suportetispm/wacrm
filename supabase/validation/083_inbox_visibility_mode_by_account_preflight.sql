-- ============================================================
-- 083_inbox_visibility_mode_by_account_preflight.sql
--
-- Preflight SOMENTE LEITURA da migration 083 — rodar ANTES de aplicar.
-- Seguro em produção: só introspecção de catálogo e SELECTs. Nenhum
-- INSERT/UPDATE/DELETE, nenhum DDL. Não expõe conteúdo de mensagens.
-- ============================================================

-- ------------------------------------------------------------
-- P1) Policies atuais de conversations e messages
-- ------------------------------------------------------------
SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('conversations', 'messages')
ORDER BY tablename, policyname;
-- Esperado ANTES da 083 (estado da 082):
--   conversations_insert — is_account_member(account_id,'agent')
--   conversations_select — is_account_member(account_id)
--   conversations_update — USING is_account_member(account_id,'agent');
--     WITH CHECK is_account_member(...,'agent') + profile mesma conta
--   (sem conversations_delete — 075)
--   messages_select / messages_modify — EXISTS conversations +
--     is_account_member(c.account_id[, 'agent'])
-- PARAR se houver QUALQUER outra policy em conversations — policies
-- permissivas somam com OR, e a 083 só substitui select/update: uma
-- policy extra continuaria abrindo a Inbox por fora da regra de Setor.

-- ------------------------------------------------------------
-- P2) RLS habilitada
-- ------------------------------------------------------------
SELECT relname, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE oid IN ('public.conversations'::regclass, 'public.messages'::regclass,
              'public.account_feature_flags'::regclass, 'public.queue_members'::regclass);
-- Esperado: rls_enabled = true nas quatro.

-- ------------------------------------------------------------
-- P3) account_feature_flags — CHECK atual, policies e linhas
-- ------------------------------------------------------------
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.conrelid = 'public.account_feature_flags'::regclass AND con.contype = 'c';
-- Esperado: 1 linha, feature_key = ANY (ARRAY['multi_connection_enabled',
-- 'business_units_enabled']). A 083 remove TODO CHECK desta tabela cuja
-- definição cite feature_key e recria com as 3 chaves — PARAR se
-- aparecer um CHECK que cite feature_key junto com OUTRA regra.

SELECT count(*) AS policies_em_account_feature_flags
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'account_feature_flags';
-- Esperado: 0 (a leitura pela RLS passa a ser só via
-- is_account_feature_enabled, criada pela 083).

SELECT f.account_id, a.name, f.feature_key, f.enabled, f.updated_by, f.updated_at
FROM public.account_feature_flags f
JOIN public.accounts a ON a.id = f.account_id
ORDER BY a.name, f.feature_key;
-- Informativo: flags já gravadas. Nenhuma pode ter feature_key =
-- 'inbox_account_wide' antes da 083 (o CHECK atual não permite).

-- ------------------------------------------------------------
-- P4) platform_set_account_feature — estado que a 083 preserva
-- ------------------------------------------------------------
SELECT
  p.prosecdef AS is_security_definer,
  p.proconfig AS config,
  r.rolname   AS owner,
  count(*) OVER () AS total_overloads,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = 'platform_set_account_feature';
-- Esperado: true, {search_path=public}, postgres, 1, false, true.
-- PARAR se config for diferente de {search_path=public}: a 083 recria a
-- função com SET search_path = public (igual à 071) e sobrescreveria
-- um ajuste feito à mão em produção.

-- ------------------------------------------------------------
-- P5) Nome da função auxiliar está livre
-- ------------------------------------------------------------
SELECT p.oid::regprocedure AS existing_function
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'is_account_feature_enabled';
-- Esperado: 0 linhas (ou exatamente a assinatura (uuid, text) numa
-- reexecução da 083).

-- ------------------------------------------------------------
-- P6) is_account_member — exige profile ativo + account ativa (048)
-- ------------------------------------------------------------
SELECT
  p.prosecdef                                   AS security_definer,
  pg_get_functiondef(p.oid) ILIKE '%p.is_active%' AS checks_profile_active,
  pg_get_functiondef(p.oid) ILIKE '%a.is_active%' AS checks_account_active,
  pg_get_functiondef(p.oid) ILIKE '%p.account_id = target_account_id%' AS checks_same_account
FROM pg_proc p
WHERE p.oid = 'public.is_account_member(uuid, account_role_enum)'::regprocedure;
-- Esperado: as 4 colunas true. PARAR se alguma for false.

-- ------------------------------------------------------------
-- P7) As duas accounts que receberão a flag existem e estão ativas
-- ------------------------------------------------------------
SELECT a.id, a.name, a.is_active,
       (SELECT count(*) FROM public.conversations c WHERE c.account_id = a.id) AS conversations
FROM public.accounts a
WHERE a.id IN ('3b1cc850-7de0-48df-ba1b-d6334b000c3b',
               '33e1388c-fb0a-457f-ba8e-c01d236897c5');
-- Esperado: 2 linhas — OUTLET - ARACAGI (168 conversations) e
-- OUTLET - COHAMA (72). PARAR se vier menos de 2: a 083 só emitiria um
-- WARNING e a account ausente ficaria segmentada por Setor.

-- ------------------------------------------------------------
-- P8) Accounts que passam a ser segmentadas por Setor — conversas
--     que ficariam invisíveis para agent/viewer
-- ------------------------------------------------------------
SELECT a.id AS account_id, a.name, a.is_active,
       count(c.id)                                                        AS conversations_total,
       count(c.id) FILTER (WHERE c.queue_id IS NULL
                             AND c.assigned_agent_id IS NULL)             AS sem_fila_e_sem_responsavel
FROM public.accounts a
LEFT JOIN public.conversations c ON c.account_id = a.id
WHERE a.id NOT IN ('3b1cc850-7de0-48df-ba1b-d6334b000c3b',
                   '33e1388c-fb0a-457f-ba8e-c01d236897c5')
GROUP BY a.id, a.name, a.is_active
ORDER BY a.name;
-- Esperado (limpeza operacional já feita): conversations_total = 0 em
-- todas. Se alguma tiver conversas, sem_fila_e_sem_responsavel é o
-- número que só owner/admin enxergarão depois da 083.

-- ------------------------------------------------------------
-- P9) Setores prontos nas accounts segmentadas — agent/viewer ativo
--     sem nenhuma fila ativa não verá conversa nenhuma por fila
-- ------------------------------------------------------------
SELECT a.name AS account, p.full_name, p.account_role,
       count(qm.queue_id) FILTER (WHERE qm.is_active) AS filas_ativas
FROM public.profiles p
JOIN public.accounts a ON a.id = p.account_id
LEFT JOIN public.queue_members qm
       ON qm.user_id = p.user_id AND qm.account_id = p.account_id
WHERE p.is_active AND a.is_active
  AND p.account_role IN ('agent', 'viewer')
  AND a.id NOT IN ('3b1cc850-7de0-48df-ba1b-d6334b000c3b',
                   '33e1388c-fb0a-457f-ba8e-c01d236897c5')
GROUP BY a.name, p.user_id, p.full_name, p.account_role
ORDER BY a.name, p.full_name;
-- Informativo: filas_ativas = 0 => esse usuário só verá conversas
-- atribuídas diretamente a ele. Não bloqueia a migration.

-- ------------------------------------------------------------
-- P10) Triggers de conversations (076/078) e Realtime
-- ------------------------------------------------------------
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns presente e habilitado ('O'),
-- além dos demais já existentes. Guardar esta lista: o check pós-
-- migration deve devolver exatamente a mesma.

SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('conversations', 'messages');
-- Esperado: 2 linhas.
