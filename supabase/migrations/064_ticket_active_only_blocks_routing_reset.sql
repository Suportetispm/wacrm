-- ============================================================
-- 064_ticket_active_only_blocks_routing_reset
--
-- Corrige a condição de "tem ticket" introduzida pela 063: um ticket
-- HISTÓRICO (status='closed') não deve mais bloquear para sempre a
-- limpeza de queue_id/assigned_agent_id nem a reabertura de status de
-- uma conversation closed/finalized. Só um ticket ATIVO
-- (status IN ('open','pending')) deve preservar o roteamento atual.
--
-- Causa raiz (auditoria aprovada nesta sessão, testada em staging):
-- as 4 funções tocadas pela 063 usam
--   NOT EXISTS (SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id)
-- sem filtro de status. Isso bloqueia inclusive um ticket 'closed'
-- histórico — cenário real reproduzido: conversation closed, ticket
-- vinculado já closed, nova mensagem inbound chega e NADA muda
-- (queue_id/assigned_agent_id continuam preenchidos, status continua
-- closed, nenhum flow_run é criado).
--
-- "Ticket ativo" não é uma definição nova inventada aqui — já é o que
-- o próprio schema garante desde a 040, via o índice único parcial
--   idx_tickets_one_active_per_conversation
--     ON tickets(conversation_id) WHERE status IN ('open', 'pending')
-- que impede mais de 1 ticket 'open'/'pending' por conversation ao
-- mesmo tempo. tickets.status só tem 3 valores possíveis (CHECK da
-- 040: 'open', 'pending', 'closed' — nunca alterado por nenhuma
-- migration posterior). Logo:
--   ativo     := status IN ('open', 'pending')
--   encerrado := status = 'closed'
-- e por construção só pode haver 0 ou 1 ticket ativo por conversation
-- — não há ambiguidade de "qual ticket" checar.
--
-- Este índice NÃO é alterado por esta migration.
--
-- Escopo: as MESMAS 4 funções que a 063 tocou, e só elas — mesma
-- assinatura, mesmo retorno, mesmo SECURITY INVOKER, mesmo
-- search_path, mesmo owner/grants (CREATE OR REPLACE não altera
-- nenhum dos três quando a assinatura não muda):
--   1. meta_reopen_conversation_on_inbound   (texto/interativo Meta)
--   2. uazapi_persist_inbound_text_message   (texto UAZAPI)
--   3. uazapi_persist_inbound_document_message (documento UAZAPI)
--   4. uazapi_persist_inbound_image_message  (imagem UAZAPI)
--
-- Alteração ÚNICA, repetida nas 3 ocorrências que cada função já
-- tinha desde a 063 (proteção de queue_id, proteção de
-- assigned_agent_id, proteção de status) — 12 substituições no total,
-- nada mais muda:
--
--   ANTES (063):
--     NOT EXISTS (
--       SELECT 1 FROM tickets
--       WHERE tickets.conversation_id = conversations.id
--     )
--
--   DEPOIS (064):
--     NOT EXISTS (
--       SELECT 1 FROM tickets
--       WHERE tickets.conversation_id = conversations.id
--         AND tickets.status IN ('open', 'pending')
--     )
--
-- Nenhuma linha de `tickets` é lida para além desse EXISTS, e
-- nenhuma linha de `tickets` é escrita por estas 4 funções — nunca
-- foi (o UPDATE de cada função sempre foi só em `conversations`).
-- Ticket antigo 'closed' permanece intocado: id, status, closed_at,
-- closed_by, close_reason, queue_id, assigned_agent_id, ticket_events
-- — tudo como histórico real de quem atendeu.
--
-- NÃO editar 038/042/043/050/063 — só CREATE OR REPLACE aqui.
-- Idempotente — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. meta_reopen_conversation_on_inbound — caminho Meta (texto e
--    resposta interativa). Mesma assinatura/retorno/security da
--    050/063.
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
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets
          WHERE tickets.conversation_id = conversations.id
            AND tickets.status IN ('open', 'pending')
        ) THEN 'pending'
        ELSE status
      END,
      updated_at = now()
  WHERE id = p_conversation_id
  RETURNING *;
$$;

-- ============================================================
-- 2. uazapi_persist_inbound_text_message — caminho UAZAPI (texto).
--    Mesma assinatura/retorno (TEXT)/security da 038/050/063.
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

  -- 064: mesma regra de limpeza condicional da 063, agora restrita a
  -- ticket ATIVO (open/pending) — ver rationale completo no cabeçalho
  -- desta migration.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets
          WHERE tickets.conversation_id = conversations.id
            AND tickets.status IN ('open', 'pending')
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
--    042/050/063. Ainda NÃO alimenta o Flow engine (ver
--    src/lib/whatsapp/uazapi-webhook-document-persist.ts) — corrigida
--    aqui só para manter o ESTADO da conversation consistente com as
--    outras 3 funções (mesmo motivo "por que as 4" já documentado na
--    063).
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

  -- 064: mesma regra de limpeza condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets
          WHERE tickets.conversation_id = conversations.id
            AND tickets.status IN ('open', 'pending')
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
--    Mesma assinatura/retorno (TEXT)/security da 043/050/063. Mesma
--    nota da função 3 acima: ainda não alimenta o Flow engine,
--    corrigida aqui só para manter o estado da conversation
--    consistente.
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

  -- 064: mesma regra de limpeza condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      queue_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE queue_id
      END,
      assigned_agent_id = CASE
        WHEN status IN ('closed', 'finalized')
         AND NOT EXISTS (
           SELECT 1 FROM tickets
           WHERE tickets.conversation_id = conversations.id
             AND tickets.status IN ('open', 'pending')
         )
        THEN NULL
        ELSE assigned_agent_id
      END,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets
          WHERE tickets.conversation_id = conversations.id
            AND tickets.status IN ('open', 'pending')
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
-- neste repositório — mesmo aviso já registrado em 034/049/050/063).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
--
--  1. Conversation 'closed', SEM nenhum ticket vinculado, queue_id e
--     assigned_agent_id preenchidos de um Flow antigo:
--       - chega texto (Meta ou UAZAPI) -> status='pending',
--         queue_id=NULL, assigned_agent_id=NULL.
--     (Comportamento idêntico ao pré-063/pré-064 — não deve regredir.)
--
--  2. Conversation 'closed' + exatamente 1 ticket, status='closed':
--       - chega texto -> status='pending', queue_id=NULL,
--         assigned_agent_id=NULL.
--     (Este é o caso que a 063 deixava bloqueado — a correção da 064.)
--
--  3. Conversation 'finalized' + ticket 'closed':
--       - chega texto -> status='pending', queue_id=NULL,
--         assigned_agent_id=NULL. Mesmo resultado do caso 2.
--
--  4. Conversation 'closed' + VÁRIOS tickets históricos, todos
--     'closed' (idx_tickets_one_active_per_conversation garante que
--     nenhum é 'open'/'pending' ao mesmo tempo):
--       - chega texto -> mesmo resultado dos casos 2/3 (o EXISTS com
--         status IN ('open','pending') continua vazio
--         independentemente de quantos tickets 'closed' existirem).
--
--  5. Conversation com ticket status='open' vinculado (independente do
--     status da conversation):
--       - chega texto -> queue_id, assigned_agent_id e status NÃO
--         mudam. Ticket continua a única autoridade.
--
--  6. Conversation com ticket status='pending' vinculado:
--       - mesmo resultado do caso 5 -> nada muda.
--
--  7. Conversation com N tickets 'closed' históricos + 1 ticket
--     'open' (o único ativo permitido pelo índice):
--       - chega texto -> nada muda (o EXISTS enxerga o 'open' e
--         ignora os 'closed'). Confirma que múltiplos tickets
--         históricos não mascaram o ticket ativo real.
--
--  8. Mesmo caso 7, mas com o ticket ativo em 'pending' em vez de
--     'open':
--       - chega texto -> nada muda. Mesmo resultado.
--
--  9. Em todos os casos 2-8: SELECT * FROM tickets WHERE id = '<id>'
--     antes e depois -> id, status, closed_at, closed_by,
--     close_reason, queue_id, assigned_agent_id, opened_at, pending_at
--     idênticos. ticket_events do ticket sem novas linhas geradas por
--     esta migration.
--
-- 10. Casos 2/3/4: comparar conversations.queue_id/assigned_agent_id
--     (limpos) com tickets.queue_id/assigned_agent_id do(s) ticket(s)
--     'closed' (preservados) -- devem divergir após a mensagem
--     inbound, confirmando que só o roteamento da CONVERSATION foi
--     resetado, nunca o do ticket.
--
-- 11. Repetir o caso 2 via uazapi_persist_inbound_text_message
--     (mensagem de texto UAZAPI).
--
-- 12. Repetir o caso 2 via uazapi_persist_inbound_image_message
--     (mensagem de imagem UAZAPI) -- status/queue_id/assigned_agent_id
--     da conversation mudam igual ao caso 11, mesmo a função ainda
--     não alimentando o Flow engine.
--
-- 13. Repetir o caso 2 via uazapi_persist_inbound_document_message
--     (mensagem de documento UAZAPI) -- mesmo resultado do 12.
--
-- 14. Repetir o caso 2 via meta_reopen_conversation_on_inbound
--     (webhook Meta) -- confirma paridade entre os dois providers.
-- ============================================================
