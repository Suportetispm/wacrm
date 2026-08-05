-- ============================================================
-- 042_uazapi_document_persistence
--
-- FASE 3.1 — base schema for persisting inbound PDF documents
-- received via the UAZAPI webhook. This migration only adds
-- structure (columns, a private Storage bucket, an RPC). It does
-- NOT wire anything into the live webhook route — the route still
-- only persists text messages (migration 038) as of this migration.
-- See docs/uazapi-webhook-progress.md for the calling code that will
-- eventually use this.
--
-- ------------------------------------------------------------
-- 1. New nullable columns on public.messages
-- ------------------------------------------------------------
-- `media_url` (migration 001) is NOT reused for this: it has always
-- meant "a public link the browser/provider can fetch directly" (see
-- the outbound flow in src/lib/storage/upload-media.ts and the
-- `chat-media`/`flow-media` buckets, both public). The Storage object
-- this migration's bucket holds is deliberately PRIVATE — overloading
-- `media_url` with an internal storage path would risk a component
-- rendering it as a raw fetchable link (message-bubble.tsx's existing
-- "document" case does exactly `<a href={media_url}>` today) and
-- leaking a path meant to only ever be resolved server-side into a
-- short-lived signed URL. Hence a distinct column set.
--
-- Nothing here is required on existing rows — old outbound document
-- messages keep using `media_url` exactly as before; these columns
-- are simply NULL for them.
-- ------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_storage_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS media_file_size BIGINT NULL,
  ADD COLUMN IF NOT EXISTS media_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_media_file_size_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_media_file_size_check
      CHECK (media_file_size IS NULL OR media_file_size >= 0);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Private Storage bucket for inbound document attachments
-- ------------------------------------------------------------
-- Unlike every existing bucket (`avatars`, `flow-media`, `chat-media`
-- — all `public = true`, purpose-built for OUTBOUND agent-composed
-- media the provider must fetch over a public link), this bucket
-- holds content received FROM a customer. It must never be
-- world-readable or listable.
--
-- `public = false` and — deliberately — NO storage.objects policy is
-- created for this bucket at all (contrast with chat-media's public
-- SELECT + account-scoped write policies in migration 023). No policy
-- means RLS denies every request from `anon`/`authenticated`; the
-- only way in is the service-role client (`supabaseAdmin()`, already
-- used by the webhook route), which bypasses RLS entirely by design.
-- A future signed-URL route will call `createSignedUrl()` server-side
-- with the same service-role client — never a client-side Storage
-- call against this bucket.
--
-- MIME allowlist starts at `application/pdf` only, matching FASE 3.1's
-- scope (the document parser in this same phase only accepts PDF).
-- File-size cap of 20 MB matches `UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES`
-- in uazapi-api.ts — the actual decoded file content is what's stored
-- here (never base64), so the Storage-layer cap and the download
-- wrapper's decoded-bytes cap intentionally share one number.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-attachments',
  'whatsapp-attachments',
  FALSE,
  20971520, -- 20 MB — matches UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ------------------------------------------------------------
-- 3. Persistence RPC for an inbound document message
-- ------------------------------------------------------------
-- Mirrors `uazapi_persist_inbound_text_message` (migration 038)
-- exactly in its guarantees and shape — same dedup mechanism (the
-- SAME unique index from 038, `(conversation_id, message_id)`; no new
-- index needed here), same single-transaction insert + conversation
-- advance, same "duplicate never touches the conversation" rule, same
-- 0-rows-updated guard that rolls back the insert if the target
-- conversation is gone, same SECURITY INVOKER / search_path / grant
-- reasoning (the only caller is the app's own service-role client —
-- no privilege gap for DEFINER to bridge, and pinning search_path
-- rules out schema-resolution tricks). No dynamic SQL.
--
-- Deliberately does NOT accept UAZAPI's `fileURL`, `mediaKey`,
-- `directPath`, any WhatsApp crypto hash, or base64 content as
-- parameters — only the already-uploaded Storage path and safe
-- metadata the caller decided to keep.
-- ------------------------------------------------------------
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

  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      updated_at        = now()
  WHERE id = p_conversation_id;

  -- Same guard as 038: aborts the function's implicit transaction,
  -- rolling back the INSERT above too, if the conversation is gone.
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_document_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ---- owner ----------------------------------------------------
-- Migration 038 (the direct precedent for this RPC's shape) left the
-- function's owner unset; most OTHER function-defining migrations in
-- this project (017-041) explicitly pin it to `postgres`. Following
-- the broader project convention here rather than 038's specific
-- omission — SECURITY INVOKER means OWNER has no runtime-privilege
-- effect either way, this is purely for consistent object metadata.
ALTER FUNCTION public.uazapi_persist_inbound_document_message(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) OWNER TO postgres;

-- ---- permissions ----------------------------------------------
-- Only the webhook route's service-role client may ever call this —
-- same reasoning as 038.
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_document_message(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_document_message(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_document_message(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_document_message(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, JSONB
) TO service_role;
