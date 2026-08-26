-- ============================================================
-- 063_reopen_clears_routing
--
-- "Nova entrada de atendimento": quando uma mensagem inbound chega
-- numa conversation que estava 'closed'/'finalized' (e que não tem
-- ticket vinculado — mesma condição que já protege `status` desde a
-- 050), o roteamento antigo (`queue_id`/`assigned_agent_id`) deixa de
-- ser válido e precisa ser limpo, senão o Flow engine nunca mais
-- inicia um novo run de triagem para esse contato — ver
-- `alreadyRouted` em src/lib/flows/engine.ts:350, que trata
-- queue_id/assigned_agent_id preenchidos como "já roteado" para
-- sempre, mesmo décadas depois do atendimento ter sido encerrado.
--
-- Causa raiz (auditoria aprovada nesta sessão): nenhum caminho de
-- "encerrar" (nem o botão direto do Inbox — só client-side `.update({
-- status })` — nem `close_ticket()` da 049) jamais limpou esses dois
-- campos. Uma vez que um Flow atribuía um setor via
-- `resolveAndAssignQueue` (assign_queue/queue_menu), `queue_id`
-- ficava preso na conversation para sempre, sobrevivendo a qualquer
-- número de ciclos de encerramento/reabertura.
--
-- Escopo: as MESMAS 4 funções que a 050 já tocou, e só elas — mesma
-- assinatura, mesmo retorno, mesmo owner/grants (CREATE OR REPLACE
-- não altera nenhum dos três quando a assinatura não muda):
--   1. meta_reopen_conversation_on_inbound   (texto/interativo Meta)
--   2. uazapi_persist_inbound_text_message   (texto UAZAPI)
--   3. uazapi_persist_inbound_document_message (documento UAZAPI)
--   4. uazapi_persist_inbound_image_message  (imagem UAZAPI)
--
-- Por que as 4, mesmo document/image ainda não alimentando o Flow
-- engine (ver comentário FASE 3.1/4C nos módulos TS correspondentes):
-- as 4 compartilham o mesmo bloco `status = CASE WHEN NOT EXISTS
-- (ticket) THEN 'pending' ELSE status END`. Se só as 2 de texto forem
-- corrigidas, um documento/imagem chegando PRIMEIRO numa conversation
-- closed reabre o status para 'pending' sem limpar o roteamento; uma
-- mensagem de texto que chegue LOGO DEPOIS já não vê mais
-- status='closed' (o documento/imagem já mudou para 'pending') e a
-- condição de limpeza do texto não dispara mais — o queue_id
-- continua sujo e o bug volta por outra porta. Corrigir as 4 fecha
-- essa lacuna com o mesmo padrão de CASE, sem inventar semântica
-- nova.
--
-- Regra exata adicionada ao UPDATE que cada função já fazia:
--   queue_id = CASE
--     WHEN status IN ('closed','finalized')
--      AND NOT EXISTS (ticket vinculado)
--     THEN NULL ELSE queue_id END,
--   assigned_agent_id = CASE (mesma condição) THEN NULL ELSE ... END
--
-- `status` do lado direito do CASE é sempre o valor DA LINHA ANTES
-- deste mesmo UPDATE (semântica padrão do Postgres: todas as
-- expressões de um SET leem o snapshot pré-update) — zero janela de
-- corrida, mesma transação que já decide o novo `status`.
--
-- pending / in_progress / waiting_customer: `status IN ('closed',
-- 'finalized')` é falso -> nada é limpo. Conversation com ticket:
-- `NOT EXISTS` é falso -> nada é limpo, em nenhum dos 3 campos —
-- ticket continua a única autoridade sobre status/roteamento nesse
-- caso, sem mudança de comportamento.
--
-- NÃO editar 038/042/043/050 — só CREATE OR REPLACE aqui.
-- Idempotente — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. meta_reopen_conversation_on_inbound — caminho Meta (texto e
--    resposta interativa). Mesma assinatura/retorno/security da 050.
-- ============================================================
CREATE OR REPLACE FUNCTION public.meta_reopen_conversation_on_inbound(
  p_conversation_id    UUID,
  p_last_message_text  TEXT,
  p_last_message_at    TIMESTAMPTZ
) RETURNS conversations
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE conversations
  SET last_message_text = p_last_message_text,
      last_message_at   = p_last_message_at,
      unread_count      = unread_count + 1,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at = now()
  WHERE id = p_conversation_id
  RETURNING *;
$$;

-- ============================================================
-- 2. uazapi_persist_inbound_text_message — caminho UAZAPI (texto).
--    Mesma assinatura/retorno (TEXT)/security da 038/050.
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_text_message(
  p_conversation_id UUID,
  p_message_id      TEXT,
  p_content_text    TEXT,
  p_occurred_at     TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted_id  UUID;
  v_updated_rows INTEGER;
BEGIN
  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at
  ) VALUES (
    p_conversation_id, 'customer', 'text', p_content_text,
    p_message_id, 'delivered', p_occurred_at
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 063: além da reabertura condicional de status já existente desde
  -- a 050, "nova entrada de atendimento" limpa queue_id/
  -- assigned_agent_id quando a conversation vinha de closed/finalized
  -- (e não tem ticket) — ver rationale completo no cabeçalho desta
  -- migration.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_text_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- 3. uazapi_persist_inbound_document_message — caminho UAZAPI
--    (documento). Mesma assinatura/retorno (TEXT)/security da
--    042/050. Ainda NÃO alimenta o Flow engine (ver
--    src/lib/whatsapp/uazapi-webhook-document-persist.ts) — corrigida
--    aqui só para manter o ESTADO da conversation consistente, para
--    que uma mensagem de texto que chegue depois não fique bloqueada
--    (ver rationale "por que as 4" no cabeçalho).
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_document_message(
  p_conversation_id    UUID,
  p_message_id         TEXT,
  p_content_text       TEXT,
  p_occurred_at        TIMESTAMPTZ,
  p_media_storage_path TEXT,
  p_media_file_name    TEXT,
  p_media_mime_type    TEXT,
  p_media_file_size    BIGINT,
  p_media_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted_id  UUID;
  v_updated_rows INTEGER;
BEGIN
  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at,
    media_storage_path, media_file_name, media_mime_type,
    media_file_size, media_metadata
  ) VALUES (
    p_conversation_id, 'customer', 'document', p_content_text,
    p_message_id, 'delivered', p_occurred_at,
    p_media_storage_path, p_media_file_name, p_media_mime_type,
    p_media_file_size, COALESCE(p_media_metadata, '{}'::jsonb)
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 063: mesma regra de limpeza condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_document_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- 4. uazapi_persist_inbound_image_message — caminho UAZAPI (imagem).
--    Mesma assinatura/retorno (TEXT)/security da 043/050. Mesma nota
--    da função 3 acima: ainda não alimenta o Flow engine, corrigida
--    aqui só para manter o estado da conversation consistente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_image_message(
  p_account_id         UUID,
  p_conversation_id    UUID,
  p_message_id         TEXT,
  p_content_text       TEXT,
  p_occurred_at        TIMESTAMPTZ,
  p_media_storage_path TEXT,
  p_media_file_name    TEXT,
  p_media_mime_type    TEXT,
  p_media_file_size    BIGINT,
  p_media_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conversation_account_id UUID;
  v_inserted_id             UUID;
  v_updated_rows            INTEGER;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: account_id is required';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: conversation_id is required';
  END IF;

  IF p_message_id IS NULL OR btrim(p_message_id) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: message_id is required';
  END IF;

  IF p_media_storage_path IS NULL
     OR btrim(p_media_storage_path) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: media storage path is required';
  END IF;

  IF p_media_mime_type IS NULL
     OR p_media_mime_type NOT IN (
       'image/jpeg',
       'image/png',
       'image/webp'
     ) THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: unsupported image MIME type';
  END IF;

  IF p_media_file_size IS NULL
     OR p_media_file_size <= 0
     OR p_media_file_size > 20971520 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: invalid image size';
  END IF;

  SELECT account_id INTO v_conversation_account_id
  FROM conversations
  WHERE id = p_conversation_id;

  IF v_conversation_account_id IS NULL
     OR v_conversation_account_id <> p_account_id THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: conversation account mismatch';
  END IF;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at,
    media_storage_path, media_file_name, media_mime_type,
    media_file_size, media_metadata
  ) VALUES (
    p_conversation_id, 'customer', 'image', p_content_text,
    p_message_id, 'delivered', p_occurred_at,
    p_media_storage_path, p_media_file_name, p_media_mime_type,
    p_media_file_size, COALESCE(p_media_metadata, '{}'::jsonb)
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 063: mesma regra de limpeza condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049/050).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
--
--  1. Conversation SEM ticket, status='closed', queue_id e
--     assigned_agent_id preenchidos de um Flow antigo:
--       - chega texto (Meta ou UAZAPI) -> status='pending',
--         queue_id=NULL, assigned_agent_id=NULL.
--       - chega documento (UAZAPI) -> mesmo resultado.
--       - chega imagem (UAZAPI) -> mesmo resultado.
--     Repetir para status='finalized' -> mesmo resultado.
--
--  2. Cenário multimídia (o caso que motivou incluir as 4 funções):
--     conversation 'closed' com queue_id preenchido ->
--       a. chega IMAGEM primeiro -> status='pending', queue_id=NULL,
--          assigned_agent_id=NULL (mesmo document/image não chamando
--          dispatchInboundToFlows ainda).
--       b. em seguida chega TEXTO -> uazapi_persist_inbound_text_message
--          roda com status já 'pending' (não mais 'closed') -> a
--          condição de limpeza desta função não dispara de novo, mas
--          não precisa: queue_id/assigned_agent_id já estão NULL desde
--          o passo (a) -> dispatchInboundToFlows recebe
--          queueId=null/assignedAgentId=null -> alreadyRouted=false ->
--          Flow com trigger_type='inbound_message' pode iniciar.
--     Repetir com DOCUMENTO no lugar de imagem no passo (a).
--
--  3. Conversation COM ticket (qualquer status de ticket, inclusive
--     closed), conversation.status='closed'/'finalized': nenhuma das
--     4 funções altera queue_id, assigned_agent_id OU status por
--     causa da mensagem inbound — comportamento idêntico ao pré-063.
--
--  4. Conversation 'pending'/'in_progress'/'waiting_customer' com
--     queue_id preenchido: nova mensagem inbound NÃO limpa queue_id
--     nem assigned_agent_id (status não está em closed/finalized).
--
--  5. meta_reopen_conversation_on_inbound: mesmos casos 1/2/3/4 acima,
--     via o webhook Meta, confirmando paridade entre os dois
--     providers.
-- ============================================================
