-- ============================================================
-- 076_conversations_update_hardening
--
-- Fecha o gap confirmado em WACRM_AUDITORIA_PERMISSIONS_CONVERSATIONS_WRITE.md:
-- `conversations_update` (017) só checava tenancy + piso de role
-- (`is_account_member(account_id,'agent')`), sem nenhuma restrição de
-- fila/atribuição — diferente de `conversations_select`, endurecida
-- em 058/059. Qualquer agent+ ativo da conta podia, via chamada
-- direta ao PostgREST (fora da UI/rotas da aplicação), atualizar
-- QUALQUER conversation da conta, mesmo uma que não consegue mais
-- nem enxergar desde 059.
--
-- AUDITORIA PRÉVIA (resumo — ver o relatório para o detalhe completo
-- e a matriz de callers):
--   - TODO caller `authenticated` que hoje escreve em `conversations`
--     (message-thread.tsx, status-automation.ts, api/ai/autoreply)
--     já opera exclusivamente sobre linhas que passaram por
--     `conversations_select` antes (a thread só abre a partir de uma
--     lista/URL já filtrada; a rota de autoreply faz SELECT antes do
--     UPDATE, mesmo client). Restringir o UPDATE à mesma regra do
--     SELECT não quebra nenhum fluxo real — só fecha o caminho de
--     escrita direta que nunca passa pela UI/rotas;
--   - ZERO caller `authenticated` toca `account_id`, `queue_id`,
--     `contact_id`, `user_id`, `created_at` (confirmado por grep
--     exaustivo — nenhuma ocorrência fora de `service_role`/RPC);
--   - `unread_count` já não tem nenhum caller `authenticated` desde a
--     migration 044 (`mark_conversation_read`, RPC dedicada) — nunca
--     foi formalmente bloqueado a nível de coluna, só deixou de ser
--     usado na prática;
--   - `assigned_agent_id` é DELIBERADAMENTE deixado FORA da proteção
--     de coluna (trigger) — é a única coluna sensível com um fluxo
--     legítimo real e amplo de escrita direta. Ganha, em vez disso,
--     uma validação de "mesma conta" no WITH CHECK da policy (ver
--     seção própria abaixo) — bloqueia atribuir a um usuário de OUTRA
--     conta, sem restringir a reatribuição/desatribuição normal entre
--     colegas da mesma conta;
--   - service_role (webhooks Meta/UAZAPI, Flow engine, Automations
--     engine, envio de mensagem) e as RPCs SECURITY DEFINER de ticket
--     (claim_ticket, transfer_ticket_queue, transfer_ticket_agent,
--     mark_ticket_waiting_customer, resume_ticket, close_ticket,
--     049/068) bypassam RLS por definição (service_role tem
--     BYPASSRLS; as RPCs rodam como `postgres`, table owner) — nenhum
--     dos dois é afetado por esta migration.
--
-- DUAS CAMADAS, PORQUE RLS RESTRINGE LINHA, NÃO COLUNA:
--
--   1. conversations_update passa a considerar fila/atribuição, mesma
--      regra de conversations_select (059), simplificada (não precisa
--      do ramo de viewer — is_account_member(account_id,'agent') já
--      exclui viewer, rank 1 < 2, igual sempre foi desde 017).
--
--   2. Novo trigger conversations_enforce_privilege_columns, MESMO
--      PADRÃO de enforce_profile_privilege_columns (034/048) — já é o
--      precedente estabelecido deste projeto para "proteger colunas
--      específicas mesmo quando a linha já passou pela checagem de
--      RLS". Sem isso, um agent cujo assigned_agent_id=auth.uid()
--      ainda poderia mover queue_id para qualquer fila (a condição de
--      linha acima passa por esse ramo independente da fila nova) —
--      a Camada 1 sozinha não fecha isso.
--
-- Colunas protegidas pelo trigger (zero writer authenticated
-- confirmado para todas, via grep exaustivo em src/**):
--   account_id    — estrutural de tenancy. Já implicitamente
--                    impossível de mudar para OUTRA conta via a
--                    Camada 1 sozinha (sem WITH CHECK explícito, o
--                    USING também valida a linha NOVA — e como este
--                    projeto tem desenho de "1 conta por usuário"
--                    (017, decisão travada), um authenticated nunca
--                    passa is_account_member() para uma conta
--                    diferente da sua própria). Adicionado ao trigger
--                    mesmo assim por defesa em profundidade explícita
--                    e simetria com as demais colunas estruturais.
--   queue_id      — roteamento; mover fila é decisão de Flow/admin,
--                    nunca do agent diretamente.
--   contact_id    — reapontar para outro contato corromperia
--                    histórico (mesma classe de risco que
--                    merge_duplicate_conversations, 036, já era
--                    postgres-only).
--   user_id       — vestigial desde 017 (account_id é quem importa),
--                    nunca deveria mudar depois do INSERT.
--   created_at    — timestamp de criação, nunca deveria mudar.
--   unread_count  — já é RPC-only na prática desde 044
--                    (mark_conversation_read); formaliza o que já era
--                    verdade, sem mudar comportamento observável.
--
-- ASSIGNED_AGENT_ID — DELIBERADAMENTE NÃO PROTEGIDA PELO TRIGGER:
--   Confirmado em src/components/inbox/message-thread.tsx:1341-1400 —
--   o dropdown "Atribuir" renderiza TODOS os membros da conta
--   (`profiles.map(...)`, sem filtro de fila) e cada clique chama
--   `handleAssignChange(p.user_id)`, que grava esse valor via UPDATE
--   direto sempre que NÃO há ticket ativo (mesmo componente também
--   expõe "Desatribuir" -> `handleAssignChange(null)`). Isto é um
--   recurso real e já em produção: reatribuição livre entre colegas
--   da conta, não restrita a membros da fila nem ao próprio usuário.
--   Restringir esta coluna a `NEW.assigned_agent_id = auth.uid()`
--   quebraria esse fluxo (o clique em qualquer colega que não seja o
--   próprio usuário resultaria em 0 linhas afetadas, silenciosamente,
--   sem erro visível ao usuário além do UPDATE "não fazer nada"). O
--   risco original (agent FORA do escopo da conversation mexendo nela)
--   já é fechado pela Camada 1 — uma vez dentro do escopo (é o
--   assigned_agent_id atual OU membro ativo da fila), reatribuir
--   livremente a qualquer colega é o comportamento correto e vigente,
--   não uma lacuna desta migration.
--
-- USING x WITH CHECK — POR QUE PRECISAM SER DIFERENTES AQUI (revisão
-- bloqueante, corrigida antes de qualquer aplicação):
--   A primeira versão desta migration usava só USING, sem WITH CHECK
--   explícito. Em Postgres, uma policy de UPDATE sem WITH CHECK
--   reaproveita o USING também para validar a linha NOVA (depois do
--   update) — e uma falha nessa validação gera ERRO (RLS violation),
--   não silenciosamente 0 linhas. Isso quebraria exatamente o fluxo
--   real que este parágrafo anterior descreve: um agent QUE NÃO É
--   membro da fila, mas É o assigned_agent_id atual (passa no USING
--   pela cláusula `assigned_agent_id = auth.uid()`), reatribuindo a
--   conversation para outro colega — a linha NOVA teria
--   `assigned_agent_id <> auth.uid()` e o agent continuaria fora da
--   fila, então o USING reaplicado como WITH CHECK falharia e o
--   Postgres rejeitaria o UPDATE inteiro com erro, mesmo sendo uma
--   reatribuição/desatribuição legítima.
--
--   Corrigido separando as duas cláusulas: USING continua controlando
--   SE o agent pode agir sobre a linha ATUAL (escopo de fila/
--   atribuição, igual antes); WITH CHECK passa a controlar só se a
--   linha NOVA continua pertencendo à mesma conta com o piso de role
--   correto — sem reexigir que o agent continue atribuído ou membro
--   da fila depois da mudança. Isso é seguro porque o trigger da
--   Camada 2 (abaixo) já impede `authenticated` de mudar `account_id`
--   nessa mesma transação (BEFORE UPDATE roda antes do WITH CHECK ser
--   avaliado) — logo `NEW.account_id` é sempre igual a `OLD.account_id`
--   para qualquer chamada `authenticated`, e o WITH CHECK nunca abre
--   uma via de mover a conversation para outra conta.
--
-- NÃO alteradas: conversations_insert, conversations_select, a
-- ausência de conversations_delete (075). Nenhuma tabela, RPC,
-- whatsapp_config, UAZAPI, Meta, Flow, Automations ou Tickets é
-- tocada.
-- ------------------------------------------------------------

-- ============================================================
-- 1) conversations_update — considera fila/atribuição na linha
--    ATUAL (USING); só tenancy/role na linha NOVA (WITH CHECK) —
--    ver justificativa acima.
-- ============================================================

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (
        assigned_agent_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.queue_members qm
          WHERE qm.queue_id = conversations.queue_id
            AND qm.user_id = auth.uid()
            AND qm.account_id = conversations.account_id
            AND qm.is_active
        )
      )
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (
      -- assigned_agent_id continua livre para mudar (reatribuir/
      -- desatribuir, ver justificativa acima) — mas o alvo, quando
      -- não NULL, precisa ser um profile da MESMA conta. Fecha o
      -- caminho de atribuir a um usuário de outra conta via UPDATE
      -- direto. NÃO checa profiles.is_active — confirmado em
      -- src/components/inbox/message-thread.tsx:266-269 que o
      -- dropdown de atribuição busca `profiles` com `select('*')`
      -- sem filtro de is_active; atribuir a um usuário inativo já é
      -- permitido hoje na prática, e esta migration não introduz uma
      -- restrição nova que a produção não tem.
      assigned_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = conversations.assigned_agent_id
          AND p.account_id = conversations.account_id
      )
    )
  );

-- ============================================================
-- 2) Trigger de proteção de colunas — mesmo padrão de
--    enforce_profile_privilege_columns (034/048). NÃO inclui
--    assigned_agent_id — ver justificativa no cabeçalho (validação
--    de mesma conta para assigned_agent_id já ficou no WITH CHECK
--    acima, não neste trigger).
-- ============================================================

CREATE OR REPLACE FUNCTION public.conversations_enforce_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.queue_id IS DISTINCT FROM OLD.queue_id
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.unread_count IS DISTINCT FROM OLD.unread_count
  )
  AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_id, queue_id, contact_id, user_id, created_at and unread_count cannot be changed directly; use Flow routing, the ticket RPCs, or mark_conversation_read'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Fecha explicitamente o mesmo padrão de EXECUTE-para-anon (via
-- default privilege do schema) já confirmado em produção e corrigido
-- em 072/073/074 para RPCs — desta vez numa função de TRIGGER.
-- Funções de trigger não precisam de EXECUTE para NENHUMA role: o
-- mecanismo de disparo de trigger do Postgres invoca a função
-- internamente como parte da execução do UPDATE, sem passar pelo
-- sistema de ACL/GRANT — é por isso que conversations_validate_queue_
-- tenancy (058) e toda a família internal_tickets_*_validate_tenancy
-- (052/065) já revogam de PUBLIC/anon/authenticated (e, nesses
-- últimos, também de service_role) sem quebrar o disparo do trigger
-- em nenhum dos dois casos — mesmo padrão aplicado aqui.
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM anon;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM service_role;
-- Nenhuma role de cliente recebe GRANT — o único "chamador" desta
-- função é o próprio motor de trigger do Postgres, que não precisa
-- de EXECUTE. postgres continua sendo o owner (ALTER FUNCTION OWNER
-- TO postgres não é necessário aqui porque CREATE OR REPLACE
-- preserva o owner já implícito de quem executa esta migration, o
-- mesmo `postgres` de toda função deste projeto).

DROP TRIGGER IF EXISTS enforce_privilege_columns ON conversations;
CREATE TRIGGER enforce_privilege_columns
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_enforce_privilege_columns();

-- current_user = 'authenticated' é o mesmo discriminador de 034/048:
-- service_role e as RPCs SECURITY DEFINER (que rodam como `postgres`)
-- nunca batem nessa condição, então continuam podendo escrever essas
-- colunas normalmente (Flow engine grava queue_id via service_role;
-- claim_ticket/transfer_ticket_agent gravam via postgres). O REVOKE
-- de EXECUTE acima não interfere nisso — o trigger dispara
-- independente de EXECUTE, para qualquer role, incluindo service_role
-- e postgres.

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 076_conversations_update_hardening_check.sql. NÃO executado
-- automaticamente por esta migration.
-- ============================================================
