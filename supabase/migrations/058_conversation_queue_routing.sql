-- ============================================================
-- 058_conversation_queue_routing
--
-- Fase 1 da triagem automática por setores (queues = "Setores").
-- conversations passa a poder saber SEU PRÓPRIO setor, independente
-- de tickets (decisão de produto: tickets não participa desta
-- funcionalidade — ver auditoria aprovada). Também abre `flow_nodes`
-- para um novo tipo de node, `assign_queue`, e restringe a
-- visibilidade de `conversations` por setor para o papel `agent`.
--
-- Etapa 0 (pré-requisito desta migration): auditoria confirmou que
-- NÃO há correção pendente em flow_runs. `idx_one_active_run_per_contact`
-- foi criado em 010_flows.sql como (user_id, contact_id), mas
-- 017_account_sharing.sql:330-340 já o substituiu por
-- (account_id, contact_id) — o índice em vigor hoje já é o correto.
-- loadActiveRunForContact() (src/lib/flows/engine.ts) já consulta por
-- (account_id, contact_id), consistente com o índice atual. Nada a
-- alterar aqui.
--
-- Idempotente — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. conversations.queue_id
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS queue_id UUID NULL REFERENCES queues(id) ON DELETE SET NULL;

-- ON DELETE SET NULL, não RESTRICT (diferente de tickets.queue_id):
-- queues nunca é fisicamente deletada pela aplicação (não há política
-- RLS de DELETE — só pause/activate/archive, ver queue-manager.tsx).
-- Isto só protege contra uma exclusão manual via service_role; nesse
-- caso a conversa deve voltar a "sem setor" em vez de bloquear a
-- exclusão.

-- Consultas do Inbox por setor dominam o caso de uso pós-triagem;
-- índice parcial mantém pequeno enquanto muitas conversas ainda
-- estiverem sem setor (queue_id IS NULL, em triagem ou nunca roteadas).
CREATE INDEX IF NOT EXISTS idx_conversations_account_queue
  ON conversations(account_id, queue_id)
  WHERE queue_id IS NOT NULL;

-- ------------------------------------------------------------
-- Tenancy: um FK simples não garante que conversations.queue_id
-- pertence à MESMA account da própria conversa. Mesmo padrão já usado
-- em whatsapp_config_validate_default_queue_account
-- (051_queue_routing_foundation.sql:76-118) — "coluna X em tabela T
-- deve referenciar uma queue da mesma account_id de T".
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.conversations_validate_queue_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queue_account_id UUID;
BEGIN
  IF NEW.queue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id INTO v_queue_account_id
  FROM queues
  WHERE id = NEW.queue_id;

  IF v_queue_account_id IS NOT NULL AND v_queue_account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'conversations.queue_id must reference a queue in the same account';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.conversations_validate_queue_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversations_validate_queue_tenancy() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_queue_tenancy ON conversations;
CREATE TRIGGER validate_queue_tenancy
  BEFORE INSERT OR UPDATE OF queue_id, account_id ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_validate_queue_tenancy();

-- ============================================================
-- 2. flow_nodes.node_type — permitir 'assign_queue'
-- ============================================================
-- Mesmo padrão de messages_content_type_check (010_flows.sql:58-66):
-- drop + re-add do CHECK inline nomeado pelo default do Postgres
-- (<table>_<column>_check).
--
-- Lista auditada contra TODO o layer TypeScript (types.ts, engine.ts,
-- validate.ts, shared.tsx NODE_META, edges.ts, node-config-form.tsx,
-- ADD_NODE_TYPES em flow-builder.tsx/flow-canvas.tsx) — os 11 tipos
-- abaixo são exatamente os que o v1 engine/builder implementam hoje.
-- 'send_media' foi adicionado ao CHECK em 016_flow_media.sql e está
-- em uso em produção ("Enviar mídia" no builder) — precisa continuar
-- na lista aqui, senão este ADD CONSTRAINT falha na validação de
-- linhas existentes (Postgres valida rows pré-existentes por padrão
-- num ADD CONSTRAINT sem NOT VALID).
--
-- 'http_fetch' É a única divergência pré-existente, real, entre este
-- CHECK e o union TypeScript: reservado desde a migration original
-- (010_flows.sql:118-129) para um node v2 que nunca chegou a ser
-- implementado (não existe em FlowNodeConfig, no engine, no validator
-- nem no builder — só em comentários "v2"). Mantido aqui sem mudança:
-- já estava no CHECK em produção antes desta migration, remover
-- agora seria uma alteração não solicitada e fora do escopo desta
-- migration (fase 1 de triagem por setor).
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'assign_queue',
    'handoff',
    'http_fetch',
    'end'
  ));

-- ============================================================
-- 3. conversations_select — visibilidade por setor
-- ============================================================
-- Mesmo formato de tickets_select (049_ticket_operations.sql:40-66),
-- já em produção: admin vê tudo da conta; viewer (member mas abaixo
-- do rank 'agent') continua vendo tudo — não mudei esse papel, não foi
-- pedido; agent só vê se: setor ainda não definido (queue_id IS NULL —
-- nunca deixar conversa em triagem/não roteada invisível), OU é o
-- responsável (assigned_agent_id = auth.uid()), OU é membro ATIVO do
-- setor da conversa.
--
-- Verificação manual (não há harness pgTAP neste repo — nenhuma
-- migration anterior tem teste automatizado de RLS; mesma observação
-- já registrada em 034_fix_profiles_update_rls.sql). Rodar via
-- PostgREST com um JWT de cada papel, contra uma instância real:
--   - owner/admin: GET /rest/v1/conversations -> deve retornar TODAS
--     as conversas da própria account, nenhuma de outra account.
--   - agent membro do setor da conversa: deve retornar a conversa.
--   - agent NÃO membro do setor (e não é o assigned_agent_id, e
--     queue_id não é NULL): NÃO deve retornar a conversa.
--   - agent para uma conversa com queue_id IS NULL: deve retornar.
--   - qualquer papel contra account_id de outra empresa: 0 linhas,
--     nunca erro que revele existência.
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
    OR (
      is_account_member(account_id, 'agent') AND NOT is_account_member(account_id, 'admin')
      AND (
        queue_id IS NULL
        OR assigned_agent_id = auth.uid()
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
