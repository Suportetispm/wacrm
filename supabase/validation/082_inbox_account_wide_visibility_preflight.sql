-- ============================================================
-- 082_inbox_account_wide_visibility_preflight.sql
--
-- Preflight SOMENTE LEITURA da migration 082 — rodar ANTES de aplicar.
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
-- Esperado ANTES da 082:
--   conversations_insert — is_account_member(account_id,'agent')
--   conversations_select — forma da 059 (admin OR agent/viewer com
--     assigned_agent_id = auth.uid() OR EXISTS queue_members ...)
--   conversations_update — forma da 076 (USING com queue_members;
--     WITH CHECK is_account_member(...,'agent') + profile mesma conta)
--   (sem conversations_delete — 075)
--   messages_select / messages_modify — EXISTS conversations +
--     is_account_member(c.account_id[, 'agent'])
-- PARAR se houver QUALQUER outra policy em conversations (ex.: uma
-- policy PERMISSIVE extra criada à mão) — policies permissivas somam
-- com OR, e a 082 só substitui select/update.

-- ------------------------------------------------------------
-- P2) RLS habilitada nas duas tabelas
-- ------------------------------------------------------------
SELECT relname, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE oid IN ('public.conversations'::regclass, 'public.messages'::regclass);
-- Esperado: rls_enabled = true nas duas.

-- ------------------------------------------------------------
-- P3) is_account_member — exige profile ativo + account ativa (048)
-- ------------------------------------------------------------
SELECT
  p.prosecdef                                   AS security_definer,
  pg_get_functiondef(p.oid) ILIKE '%p.is_active%' AS checks_profile_active,
  pg_get_functiondef(p.oid) ILIKE '%a.is_active%' AS checks_account_active,
  pg_get_functiondef(p.oid) ILIKE '%p.account_id = target_account_id%' AS checks_same_account
FROM pg_proc p
WHERE p.oid = 'public.is_account_member(uuid, account_role_enum)'::regprocedure;
-- Esperado: as 4 colunas true. PARAR se alguma for false — a 082
-- depende inteiramente desta função para isolamento e usuário ativo.

-- ------------------------------------------------------------
-- P4) Trigger que protege queue_id/account_id/... continua presente
-- ------------------------------------------------------------
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns presente e habilitado ('O').

-- ------------------------------------------------------------
-- P5) Realtime publica conversations e messages
-- ------------------------------------------------------------
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('conversations', 'messages');
-- Esperado: 2 linhas.

-- ------------------------------------------------------------
-- P6) Integridade de tenancy — tudo deve ser 0
-- ------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.conversations WHERE account_id IS NULL)                        AS conversations_sem_account,
  (SELECT count(*) FROM public.profiles WHERE is_active AND account_id IS NULL)               AS profiles_ativos_sem_account,
  (SELECT count(*) FROM public.profiles WHERE is_active AND account_role IS NULL)             AS profiles_ativos_sem_role,
  (SELECT count(*) FROM public.conversations c
     WHERE c.assigned_agent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.user_id = c.assigned_agent_id AND p.account_id = c.account_id)) AS conv_responsavel_fora_da_account;
-- conv_responsavel_fora_da_account > 0 NÃO bloqueia a 082, mas essas
-- linhas falham no WITH CHECK (inalterado da 076) em QUALQUER UPDATE
-- feito por authenticated (status, claim...) até alguém reatribuir.
-- Listar com a consulta P6b se > 0.

-- P6b) (só se P6.conv_responsavel_fora_da_account > 0)
SELECT c.id, c.account_id, c.assigned_agent_id, c.status, c.last_message_at
FROM public.conversations c
WHERE c.assigned_agent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = c.assigned_agent_id AND p.account_id = c.account_id)
ORDER BY c.last_message_at DESC NULLS LAST
LIMIT 50;

-- ------------------------------------------------------------
-- P7) Impacto por account — quantas conversas cada agent/viewer
--     ativo NÃO enxerga hoje (regra 059) e passará a enxergar.
-- ------------------------------------------------------------
WITH members AS (
  SELECT p.user_id, p.full_name, p.account_id, p.account_role
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.is_active AND a.is_active AND p.account_role IN ('agent', 'viewer')
)
SELECT
  a.name AS account,
  m.full_name,
  m.account_role,
  count(c.id) AS conversas_da_account,
  count(c.id) FILTER (
    WHERE c.assigned_agent_id = m.user_id
       OR EXISTS (SELECT 1 FROM public.queue_members qm
                  WHERE qm.queue_id = c.queue_id AND qm.user_id = m.user_id
                    AND qm.account_id = c.account_id AND qm.is_active)
  ) AS visiveis_hoje_059,
  count(c.id) FILTER (WHERE c.queue_id IS NULL)          AS sem_fila,
  count(c.id) FILTER (WHERE c.assigned_agent_id IS NULL) AS sem_responsavel
FROM members m
JOIN public.accounts a ON a.id = m.account_id
LEFT JOIN public.conversations c ON c.account_id = m.account_id
GROUP BY a.name, m.user_id, m.full_name, m.account_role
ORDER BY a.name, m.full_name;
-- Depois da 082, cada linha deve passar a ver conversas_da_account
-- (e nada de outra account). Filtrar por a.name ILIKE 'OUTLET%' se
-- quiser só as unidades citadas.

-- ------------------------------------------------------------
-- P8) Totais por account (referência para o check pós-migration)
-- ------------------------------------------------------------
SELECT a.id AS account_id, a.name, a.is_active,
       count(c.id) AS conversations_total
FROM public.accounts a
LEFT JOIN public.conversations c ON c.account_id = a.id
GROUP BY a.id, a.name, a.is_active
ORDER BY a.name;
