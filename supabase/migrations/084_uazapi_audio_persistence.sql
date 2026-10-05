-- ============================================================
-- 084_uazapi_audio_persistence
--
-- Recebimento de áudio / nota de voz via UAZAPI. Mesma estrutura da
-- 043 (imagem), sem nenhuma coluna nova:
--   `messages.media_storage_path` / `media_file_name` /
--   `media_mime_type` / `media_file_size` / `media_metadata` (042) e o
--   valor `'audio'` do CHECK de `content_type` (001/010) já existem.
--
-- O arquivo armazenado é SEMPRE MP3: o webhook pede à UAZAPI
-- `POST /message/download` com `generate_mp3: true` e baixa o
-- `fileURL` retornado imediatamente (retenção limitada), validando a
-- assinatura real do arquivo antes do upload
-- (src/lib/whatsapp/uazapi-webhook-audio-persist.ts). Por isso só
-- `audio/mpeg` é adicionado ao bucket e aceito pela RPC.
--
-- 1. Bucket privado `whatsapp-attachments`: acrescenta `audio/mpeg` ao
--    `allowed_mime_types`, preservando os 4 tipos existentes (043).
--    `public = false` e `file_size_limit` (20 MB) inalterados.
-- 2. RPC `uazapi_persist_inbound_audio_message`: cópia fiel da versão
--    VIGENTE de `uazapi_persist_inbound_image_message` (064 — não a
--    043), trocando apenas `content_type` ('audio') e a whitelist de
--    MIME ('audio/mpeg'). Mantém: validação de entrada com mensagens
--    fixas, re-checagem `conversation.account_id = p_account_id`,
--    dedup por `ON CONFLICT (conversation_id, message_id) DO NOTHING`
--    (índice da 038), avanço da conversation na mesma transação, regra
--    063/064 de reabertura/limpeza de roteamento só sem ticket ATIVO,
--    guarda de 0 linhas atualizadas, SECURITY INVOKER,
--    `search_path = public`, owner postgres e EXECUTE só para
--    postgres/service_role (nunca PUBLIC/anon/authenticated).
--
-- Idempotente — UPDATE do bucket e CREATE OR REPLACE FUNCTION;
-- REVOKE/GRANT são no-op quando já aplicados.
--
-- NÃO APLICADA nesta etapa — aplicação manual (SQL Editor) só após
-- revisão. Sem ela, o upload falha (bucket sem `audio/mpeg`) ou a RPC
-- não existe (o upload é limpo, sem órfão): a rota responde 503 com um
-- código fixo no log e nenhuma mensagem é gravada. Não há garantia de
-- reentrega pela UAZAPI — tratar como falha observável (áudio perdido),
-- não como algo que se resolve sozinho. Aplicar ANTES do deploy.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widen the bucket's allowed MIME types
-- ------------------------------------------------------------
DO $$
BEGIN
  UPDATE storage.buckets
  SET
    public = false,
    file_size_limit = 20971520,
    allowed_mime_types = ARRAY[
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'audio/mpeg'
    ]::text[]
  WHERE id = 'whatsapp-attachments';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Required storage bucket whatsapp-attachments was not found';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 2. Persistence RPC for an inbound audio message
-- ------------------------------------------------------------
-- Deliberately does NOT accept UAZAPI's `URL`/`fileURL`, `mediaKey`,
-- `directPath`, `waveform`, any WhatsApp crypto hash or base64 — only
-- the already-uploaded Storage path and sanitized metadata
-- (format/decodedSize/voiceNote/sourceMimeType/durationSeconds) the
-- caller decided to keep. No dynamic SQL.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_audio_message(
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
      'uazapi_persist_inbound_audio_message: account_id is required';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: conversation_id is required';
  END IF;

  IF p_message_id IS NULL OR btrim(p_message_id) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: message_id is required';
  END IF;

  IF p_media_storage_path IS NULL
     OR btrim(p_media_storage_path) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: media storage path is required';
  END IF;

  IF p_media_mime_type IS NULL
     OR p_media_mime_type NOT IN (
       'audio/mpeg'
     ) THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: unsupported audio MIME type';
  END IF;

  IF p_media_file_size IS NULL
     OR p_media_file_size <= 0
     OR p_media_file_size > 20971520 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: invalid audio size';
  END IF;

  SELECT account_id INTO v_conversation_account_id
  FROM conversations
  WHERE id = p_conversation_id;

  IF v_conversation_account_id IS NULL
     OR v_conversation_account_id <> p_account_id THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_audio_message: conversation account mismatch';
  END IF;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at,
    media_storage_path, media_file_name, media_mime_type,
    media_file_size, media_metadata
  ) VALUES (
    p_conversation_id, 'customer', 'audio', p_content_text,
    p_message_id, 'delivered', p_occurred_at,
    p_media_storage_path, p_media_file_name, p_media_mime_type,
    p_media_file_size, COALESCE(p_media_metadata, '{}'::jsonb)
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- Mesma regra 063/064 da versão de imagem: reabre/limpa roteamento
  -- só quando não há ticket ATIVO vinculado.
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
      'uazapi_persist_inbound_audio_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ---- owner ----------------------------------------------------
ALTER FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) OWNER TO postgres;

-- ---- permissions ----------------------------------------------
-- Only the webhook route's service-role client may ever call this.
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) TO postgres;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_audio_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL (somente leitura, após aplicar):
--   SELECT allowed_mime_types, public, file_size_limit
--   FROM storage.buckets WHERE id = 'whatsapp-attachments';
--   SELECT p.proname, p.prosecdef, p.proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
--   FROM pg_proc p WHERE p.proname = 'uazapi_persist_inbound_audio_message';
-- Esperado: audio/mpeg na lista, public=false; prosecdef=false,
-- search_path=public, auth_exec=false, anon_exec=false, service_exec=true.
-- ============================================================
