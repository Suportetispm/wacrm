-- ============================================================
-- 069_conversation_active_ticket_visibility
--
-- Fecha o risco residual documentado ao final da Etapa 2 da
-- sincronização Inbox ↔ Tickets: a Inbox detectava "ticket ativo" via
-- embed Supabase de `tickets(id,status,assigned_agent_id,queue_id)`
-- a partir de `conversations` — sujeito à RLS `tickets_select`
-- (040_tickets.sql), que só deixa um agent comum enxergar um ticket
-- do qual é o assigned_agent OU membro ativo da fila DO TICKET.
--
-- `conversations_select` (059_agent_queue_visibility_strict.sql)
-- escopa por fila DA CONVERSATION, um campo deliberadamente
-- desacoplado de tickets.queue_id (068, comentário de
-- transfer_ticket_queue). Como os dois `queue_id` podem divergir
-- (transfer_ticket_queue só muda o do ticket), existe um agent que:
--   - enxerga a conversation (é membro da fila DELA);
--   - mas não enxerga o ticket ativo (não é membro da fila ATUAL do
--     ticket, nem o assigned_agent).
-- Para esse agent, o embed retornava zero linhas -> a Inbox concluía
-- "sem ticket ativo" -> caía no UPDATE direto de conversations,
-- podendo divergir de tickets.* de novo — exatamente o que a Etapa 2
-- existe para evitar.
--
-- ESCOPO DESTA MIGRATION (estritamente):
--   1 função nova, SECURITY DEFINER, só leitura, retornando um
--   BOOLEAN de existência — nunca dados do ticket. Nenhuma tabela é
--   criada/alterada. Nenhuma RLS é alterada. Nenhuma das RPCs de
--   049/068 é tocada.
--
-- POR QUE NÃO REUTILIZAR ticketed_conversation_ids() (050) —
-- auditoria feita antes de escrever esta migration:
--   - Definição atual (050_conversation_auto_pending.sql):
--       LANGUAGE sql, SECURITY DEFINER, STABLE, SET search_path = public
--       SELECT DISTINCT t.conversation_id FROM tickets t
--       JOIN profiles p ON p.account_id = t.account_id
--       JOIN accounts a ON a.id = t.account_id
--       WHERE p.user_id = auth.uid() AND p.is_active AND a.is_active;
--   - Grants: REVOKE ALL de PUBLIC/anon/service_role, GRANT EXECUTE só
--     para authenticated.
--   - Considera QUALQUER ticket do conversation_id, sem filtro de
--     status — inclui tickets 'closed'. Isso é correto para seus 2
--     callers atuais (src/lib/inbox/status-automation.ts:
--     openPendingConversation/sweepStaleConversations), que querem
--     "esta conversation já teve ticket alguma vez, nunca mais mexer
--     nela por automação" — um contrato deliberadamente mais amplo que
--     "tem ticket ATIVO agora".
--   - Retorna SETOF UUID de conversation_id — nada de ticket_id,
--     status, queue_id ou assigned_agent_id.
--   - Reaproveitar sua semântica (qualquer status) devolveria `true`
--     para uma conversation cujo único ticket já foi fechado há meses
--     — bloquearia a Inbox de usar o UPDATE direto para sempre, sem
--     necessidade. Alterar o corpo dela para adicionar
--     `AND t.status IN ('open','pending')` quebraria silenciosamente
--     os 2 callers acima (querem "todos", não só "ativos"). Por isso:
--     função NOVA, não uma alteração da existente — confirma a
--     instrução de não reaproveitar cegamente.
--
-- FUNÇÃO NOVA: conversation_has_active_ticket(p_conversation_id UUID)
-- RETURNS BOOLEAN
--   - SECURITY DEFINER: necessário para ultrapassar tickets_select (a
--     mesma razão de ticketed_conversation_ids() — ver seu próprio
--     comentário em 050, linha 283-296) — sem isso, o EXISTS interno
--     ficaria sujeito à mesma RLS que este fix existe para contornar.
--   - SET search_path = '' + toda relação schema-qualified
--     (public.profiles/accounts/conversations/tickets) — convenção
--     mais defensiva estabelecida em 066/067 (search_path=public foi
--     descontinuado a partir dali), não a convenção mais antiga de
--     049/068.
--   - Reimplementa a MESMA checagem de tenancy/is_active que
--     ticketed_conversation_ids() já faz (profile ativo + account
--     ativa), e adicionalmente valida que p_conversation_id pertence à
--     própria account do chamador antes de olhar tickets — nunca
--     confia em RLS para isso, sendo SECURITY DEFINER.
--   - Retorna `false` (nunca uma exceção que os distinga) tanto para
--     "conversation não existe" quanto para "conversation de outra
--     account" quanto para "existe mas sem ticket ativo" — elimina o
--     canal lateral que deixaria alguém confirmar a existência de uma
--     conversation de outro tenant por tentativa/erro.
--   - "Ativo" continua = tickets.status IN ('open','pending'), igual a
--     toda a Etapa 2 — não redefinido aqui.
--   - Não retorna ticket_id/status/assigned_agent_id/queue_id — só o
--     boolean. Quem chamar isto não ganha nenhum acesso a detalhes do
--     ticket que não teria de outra forma.
--
-- USO (frontend, fora desta migration): a Inbox passa a ter 3 estados
-- em vez de 2 — NO_ACTIVE_TICKET / ACTIVE_TICKET_VISIBLE /
-- ACTIVE_TICKET_HIDDEN — ver src/lib/inbox/ticket-sync.ts e
-- src/lib/inbox/active-ticket-visibility.ts (mesmo PR/etapa, arquivo
-- de aplicação, não desta migration). O terceiro estado (ticket ativo,
-- mas oculto pela RLS de tickets) NUNCA tenta um UPDATE direto em
-- conversations nem chama uma RPC de ticket com um ticket_id
-- inventado — bloqueia a ação com uma mensagem amigável.
--
-- IDEMPOTÊNCIA: CREATE OR REPLACE FUNCTION substitui o corpo inteiro;
-- REVOKE/GRANT são no-op quando já aplicados. Seguro reexecutar.
--
-- NÃO aplicada nesta etapa — revisão manual pendente antes de rodar
-- contra staging/produção. Script de validação separado em
-- supabase/validation/069_conversation_active_ticket_visibility_check.sql
-- (não faz parte desta migration, não é aplicado por ela).
-- ============================================================

CREATE OR REPLACE FUNCTION public.conversation_has_active_ticket(
  p_conversation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_conv_account_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_conversation_id IS NULL THEN
    RETURN false;
  END IF;

  -- No profile, or caller/account disabled: behave exactly like "no
  -- active ticket" rather than raising — same no-exception-based side
  -- channel discipline as the cross-account branch below. LIMIT 1 is
  -- defensive only (user_id is expected unique per profile row).
  SELECT p.account_id
    INTO v_caller_account_id
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
    AND p.is_active IS TRUE
    AND a.is_active IS TRUE
  LIMIT 1;

  IF v_caller_account_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT c.account_id INTO v_conv_account_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id;

  -- Conversation missing OR belongs to a different account: identical
  -- `false` response either way — never reveals whether a conversation
  -- id from another tenant exists.
  IF v_conv_account_id IS NULL OR v_conv_account_id <> v_caller_account_id THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tickets t
    WHERE t.conversation_id = p_conversation_id
      AND t.account_id = v_caller_account_id
      AND t.status IN ('open', 'pending')
  );
END;
$$;

ALTER FUNCTION public.conversation_has_active_ticket(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_has_active_ticket(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.conversation_has_active_ticket(UUID) TO authenticated;

-- ============================================================
-- VALIDAÇÃO MANUAL — rodar contra staging, nunca produção, antes de
-- aplicar em produção. Script completo e separado em
-- supabase/validation/069_conversation_active_ticket_visibility_check.sql
-- (não faz parte desta migration, não é aplicado por ela).
-- ============================================================
