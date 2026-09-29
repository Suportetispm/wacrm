-- ============================================================
-- 075_table_and_conversation_delete_hardening
--
-- Fecha as duas pendências de menor risco identificadas na auditoria
-- WACRM_AUDITORIA_PERMISSIONS_CONVERSATIONS_WRITE.md:
--
--   1. user_permission_overrides (062) — RLS habilitada, zero
--      policies (deny-by-default já funciona por construção do
--      Postgres), mas sem o REVOKE ALL explícito que platform_admins
--      (046) e account_feature_flags (071) têm como defesa em
--      profundidade. Não é vulnerabilidade ativa — único acesso hoje
--      é service_role via src/lib/permissions/store.ts
--      (supabaseAdmin()). Puramente aditivo/defensivo.
--
--   2. conversations DELETE — a policy conversations_delete (017)
--      permite qualquer agent+ da conta apagar QUALQUER conversation
--      da própria conta via PostgREST direto (USING
--      is_account_member(account_id,'agent'), sem checagem de
--      fila/atribuição), e grep exaustivo em src/** confirma ZERO
--      chamadas de `.delete()` em conversations em toda a aplicação
--      — capacidade destrutiva, irreversível, sem nenhum caller
--      legítimo. Removida sem substituir por outra policy: mesmo
--      padrão já usado por `tickets` (049), que não tem NENHUMA
--      policy de escrita para authenticated, deny-by-default, tudo
--      via RPC quando uma operação de fato precisar existir no
--      futuro.
--
-- NÃO tocada nesta migration: conversations_insert, conversations_update,
-- conversations_select — ficam exatamente como estão. UPDATE fica para
-- uma migration separada (076), depois de mapear coluna a coluna quem
-- escreve o quê hoje (RLS restringe LINHAS, não COLUNAS — a regra do
-- select de 059 não implica automaticamente a regra correta de
-- update para assigned_agent_id/queue_id).
--
-- Nenhuma tabela, coluna, trigger, RPC, RLS de outra tabela,
-- whatsapp_config, UAZAPI, Meta, Flow, Tickets ou Automations é
-- tocada. service_role/postgres continuam com acesso total (não são
-- revogados em nenhum dos dois blocos).
-- ------------------------------------------------------------

-- ============================================================
-- 1) user_permission_overrides — REVOKE ALL explícito (defesa em
--    profundidade, mesma postura de platform_admins/046 e
--    account_feature_flags/071). RLS continua habilitada, zero
--    policies continua sendo a proteção primária — isto só fecha o
--    caminho hipotético de um GRANT de schema padrão ou uma policy
--    futura adicionada por engano.
-- ============================================================

REVOKE ALL ON TABLE public.user_permission_overrides FROM PUBLIC;
REVOKE ALL ON TABLE public.user_permission_overrides FROM anon;
REVOKE ALL ON TABLE public.user_permission_overrides FROM authenticated;

-- service_role NÃO é revogado — é o único caminho legítimo hoje
-- (src/lib/permissions/store.ts, via supabaseAdmin()).

-- ============================================================
-- 2) conversations — remove a policy de DELETE, sem substituir por
--    outra. Resultado: authenticated não consegue mais DELETE em
--    conversations por nenhum caminho (nem dentro nem fora do
--    próprio escopo de fila) — RLS nega por ausência de policy,
--    igual a `tickets`. service_role/postgres continuam podendo
--    apagar (bypassam RLS por definição/ownership), se algum dia
--    houver necessidade administrativa real.
-- ============================================================

DROP POLICY IF EXISTS conversations_delete ON public.conversations;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 075_table_and_conversation_delete_hardening_check.sql. NÃO
-- executado automaticamente por esta migration.
-- ============================================================
