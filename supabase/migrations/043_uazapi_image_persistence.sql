-- ============================================================
-- 043_uazapi_image_persistence
--
-- FASE 4B/4C — widens the private `whatsapp-attachments` bucket
-- (migration 042) to also accept inbound images, and adds the
-- atomic persistence RPC the image webhook path calls. Mirrors
-- migration 042's shape and guarantees exactly, adapted for images.
--
-- No column changes: `messages.media_storage_path` /
-- `media_file_name` / `media_mime_type` / `media_file_size` /
-- `media_metadata` (042) and `content_type`'s `'image'` value (001)
-- already exist and already cover this case.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. Widen the bucket's allowed MIME types
-- ------------------------------------------------------------
-- `public = false` and `file_size_limit` (20 MB, matching
-- UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) are explicitly re-asserted
-- here, not just left alone — defense in depth against the row having
-- drifted from 042's original values by the time this migration runs.
-- No storage.objects policy is added (same deliberate "service-role
-- only" posture as 042). Existing PDF objects and rows are untouched
-- by this statement; 'application/pdf' stays in the array. `IF NOT
-- FOUND` catches the bucket row being missing entirely (e.g. migration
-- 042 not yet applied, or the row deleted out of band) — failing the
-- migration loudly instead of silently widening nothing.
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
      'image/webp'
    ]::text[]
  WHERE id = 'whatsapp-attachments';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Required storage bucket whatsapp-attachments was not found';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 2. Persistence RPC for an inbound image message
-- ------------------------------------------------------------
-- Same atomicity/dedup guarantees as
-- `uazapi_persist_inbound_document_message` (042): same
-- `(conversation_id, message_id)` unique index from migration 038, no
-- new index needed; single-transaction insert + conversation advance;
-- duplicate never touches the conversation; 0-rows-updated guard rolls
-- back the insert if the target conversation is gone.
--
-- One deliberate addition over 042's RPC: this one takes p_account_id
-- and independently re-verifies conversation.account_id = p_account_id
-- before inserting anything, raising if they don't match. 042's RPC
-- omitted an account_id parameter on purpose (see its comment) to
-- avoid a second, independently-suppliable copy of tenancy that could
-- drift from the truth; here it's added anyway as a deliberate second
-- layer of defense-in-depth on top of (not instead of) the same
-- resolved-conversation check the TypeScript persistence layer already
-- does before calling this RPC — the caller is still the only source
-- of `p_account_id`, so this catches a caller bug, not a client-
-- supplied value.
--
-- Deliberately does NOT accept UAZAPI's `URL`, `mediaKey`,
-- `directPath`, any WhatsApp crypto hash, base64 content, or the raw
-- JPEG/PNG/WebP thumbnail — only the already-uploaded Storage path and
-- sanitized metadata (width/height/captionPresent/decodedSize/format)
-- the caller decided to keep. No dynamic SQL.
-- ------------------------------------------------------------
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
  v_updated_rows             INTEGER;
BEGIN
  -- Input validation, before any lookup or write. Error messages are
  -- fixed strings only — never the received value, path, id, or MIME
  -- type — same "never leak the payload into an error" posture as the
  -- rest of this function.
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

  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      updated_at        = now()
  WHERE id = p_conversation_id;

  -- Same guard as 038/042: aborts the function's implicit transaction,
  -- rolling back the INSERT above too, if the conversation is gone.
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ---- owner ----------------------------------------------------
ALTER FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) OWNER TO postgres;

-- ---- permissions ----------------------------------------------
-- Only the webhook route's service-role client may ever call this.
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) TO postgres;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_image_message(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) TO service_role;
