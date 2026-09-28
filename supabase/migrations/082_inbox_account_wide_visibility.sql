-- ============================================================
-- 082_inbox_account_wide_visibility
--
-- Simplifica a VISIBILIDADE da Caixa de Entrada: todo usuário ativo
-- de uma account ativa enxerga TODAS as conversations daquela mesma
-- account. assigned_agent_id e queue_id deixam de ser barreira de
-- visibilidade — continuam existindo e sendo gravados/lidos para
-- responsável, roteamento, Flow, tickets e filtros de interface.
--
-- ------------------------------------------------------------
-- Causa (auditoria WACRM_AUDITORIA de visibilidade da Inbox)
-- ------------------------------------------------------------
-- 059_agent_queue_visibility_strict.sql restringiu conversations_select
-- de agent/viewer a:
--   assigned_agent_id = auth.uid()
--   OR membro ativo de queue_members da conversations.queue_id
-- Toda conversation nova nasce com queue_id NULL e assigned_agent_id
-- NULL (webhook UAZAPI/Meta) e só ganha fila se um Flow ativo rotear;
-- a reabertura (063/064) zera os dois. Resultado em produção: owner/
-- admin viam tudo, vendedores não viam conversas não roteadas/não
-- atribuídas, e o owner distribuía manualmente.
--
-- 076_conversations_update_hardening.sql espelhou a MESMA restrição no
-- USING de conversations_update. Se só o SELECT fosse aberto, o agent
-- enxergaria a conversa mas o claim-ao-abrir (status-automation.ts),
-- a troca de status, a atribuição manual (message-thread.tsx) e a
-- atualização da prévia após envio (send-message.ts) casariam 0
-- linhas silenciosamente. Por isso o USING do UPDATE acompanha.
--
-- ------------------------------------------------------------
-- Regra nova
-- ------------------------------------------------------------
-- SELECT: is_account_member(account_id)
--   = profile de auth.uid() com account_id = conversations.account_id
--     AND profiles.is_active AND accounts.is_active (048) — qualquer
--     papel (owner/admin/agent/viewer). Viewer continua read-only
--     (não passa em nenhuma policy de escrita). Não existe permissão
--     específica de Inbox/conversations no catálogo de overrides
--     (src/lib/auth/permissions.ts) nem gate de Inbox por papel
--     (sidebar.tsx) — "autorizado à Inbox" hoje É ser membro ativo.
--     Mesmo critério que messages_select (017) já usa: conversations e
--     messages voltam a ter exatamente o mesmo isolamento.
--
-- UPDATE USING: is_account_member(account_id, 'agent')
-- UPDATE WITH CHECK: INALTERADO (076) — assigned_agent_id, quando não
--   NULL, precisa apontar para um profile da MESMA account.
-- Trigger enforce_privilege_columns (076/078): INALTERADO — agent
--   continua sem poder mudar account_id, queue_id, contact_id,
--   user_id, created_at, unread_count, whatsapp_config_id.
--
-- ------------------------------------------------------------
-- Isolamento multiaccount
-- ------------------------------------------------------------
-- Toda cláusula passa por is_account_member(conversations.account_id,
-- ...), que exige p.account_id = target_account_id para auth.uid().
-- Usuário de outra account, usuário inativo, account inativa, ou
-- usuário sem profile/membership => false => 0 linhas. Nenhuma policy
-- permissiva global, nenhum USING (true), RLS continua habilitada.
--
-- ------------------------------------------------------------
-- NÃO FAZ
-- ------------------------------------------------------------
-- Não altera dados (nenhum UPDATE/INSERT/DELETE em linhas), não
-- atribui conversas, não preenche queue_id, não toca assigned_agent_id
-- existente. Não altera conversations_insert, a ausência de
-- conversations_delete (075), messages_*, tickets_* (tickets continuam
-- com a regra de fila/responsável de 049), queues, queue_members,
-- is_account_member, triggers, RPCs, Flows ou UAZAPI.
--
-- Realtime: postgres_changes avalia a policy de SELECT por assinante;
-- com esta regra, INSERT/UPDATE de conversations da própria account
-- passam a ser entregues a todo membro ativo (messages já eram).
--
-- Idempotente — DROP POLICY IF EXISTS + CREATE. Seguro reexecutar.
-- Preflight: supabase/validation/082_inbox_account_wide_visibility_preflight.sql
-- Check:     supabase/validation/082_inbox_account_wide_visibility_check.sql
-- ============================================================

-- ------------------------------------------------------------
-- Atomicidade
-- ------------------------------------------------------------
-- DROP + CREATE das duas policies numa transação EXPLÍCITA: ou as
-- duas trocas entram juntas, ou nada muda (qualquer erro => ROLLBACK
-- implícito ao fim do bloco; conversations nunca fica sem policy de
-- SELECT/UPDATE, nem com só uma das duas trocada). Não depende de o
-- cliente (SQL Editor, psql sem -1, etc.) agrupar os comandos numa
-- única transação. DDL de policy pega ACCESS EXCLUSIVE em
-- conversations até o COMMIT; lock_timeout curto (mesma convenção da
-- 081) faz a migration falhar rápido em vez de enfileirar o tráfego
-- do app atrás dela.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1) conversations_select — toda a account, qualquer membro ativo
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (
    public.is_account_member(account_id)
  );

-- ============================================================
-- 2) conversations_update — USING por account (agent+); WITH CHECK
--    idêntico ao da 076.
-- ============================================================
DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations FOR UPDATE
  USING (
    public.is_account_member(account_id, 'agent')
  )
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = conversations.assigned_agent_id
          AND p.account_id = conversations.account_id
      )
    )
  );

COMMIT;
