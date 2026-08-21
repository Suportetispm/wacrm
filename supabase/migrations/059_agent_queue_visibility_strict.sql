-- ============================================================
-- 059_agent_queue_visibility_strict
--
-- Corrige APENAS a visibilidade de conversations por setor
-- (conversations_select). Não altera schema, não adiciona coluna,
-- não toca em dados/linhas existentes, não altera RLS de messages,
-- contacts, queues, queue_members, tickets, profiles, flows,
-- automations ou whatsapp_config.
--
-- ------------------------------------------------------------
-- Problema corrigido (auditoria "Isolamento da Inbox por Setor")
-- ------------------------------------------------------------
-- A policy criada em 058_conversation_queue_routing.sql tinha duas
-- aberturas amplas demais agora que o Flow de triagem já preenche
-- conversations.queue_id de verdade:
--
--   1. agent enxergava qualquer conversation com queue_id IS NULL,
--      independente de setor — cláusula pensada para "nunca deixar
--      conversa em triagem invisível", mas na prática deixava
--      qualquer agent ver conversas de qualquer setor enquanto
--      não roteadas.
--   2. viewer não tinha NENHUMA restrição de setor — via a conta
--      inteira (mesma cláusula "member AND NOT agent-rank" que dá
--      acesso irrestrito).
--
-- ------------------------------------------------------------
-- Regra decidida nesta revisão
-- ------------------------------------------------------------
-- owner / admin: continuam vendo todas as conversations da própria
--   account (cláusula is_account_member(account_id,'admin') não
--   muda).
-- agent E viewer (ambos abaixo de admin): só enxergam a conversation
--   quando pelo menos uma condição:
--     (a) assigned_agent_id = auth.uid() — é o responsável;
--     (b) é membro ATIVO da queue da conversa:
--         queue_members.queue_id = conversations.queue_id
--         AND queue_members.user_id = auth.uid()
--         AND queue_members.account_id = conversations.account_id
--         AND queue_members.is_active
--   Nenhum dos dois ganha mais acesso automático por
--   queue_id IS NULL. role_in_queue (agent/supervisor) não importa
--   aqui — membership ativo é suficiente, por decisão explícita
--   desta revisão (não introduz capacidade nova de supervisor).
--
-- Nunca cross-account: is_account_member() e o EXISTS contra
-- queue_members exigem account_id igual ao da própria conversation
-- em toda cláusula — igual à 058, isso não muda.
--
-- Idempotente — safe to run multiple times. NÃO EXECUTADA nesta
-- revisão (revisão pendente antes de aplicar no Supabase).
-- ============================================================

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent') AND NOT is_account_member(account_id, 'admin')
      AND (
        assigned_agent_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM queue_members qm
          WHERE qm.queue_id = conversations.queue_id
            AND qm.user_id = auth.uid()
            AND qm.account_id = conversations.account_id
            AND qm.is_active
        )
      )
    )
    OR (
      is_account_member(account_id) AND NOT is_account_member(account_id, 'agent')
      AND (
        assigned_agent_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM queue_members qm
          WHERE qm.queue_id = conversations.queue_id
            AND qm.user_id = auth.uid()
            AND qm.account_id = conversations.account_id
            AND qm.is_active
        )
      )
    )
  );
