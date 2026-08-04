-- ============================================================
-- 038_uazapi_message_dedup
--
-- Idempotency guard for inbound UAZAPI webhook message inserts
-- (etapa 8.2D/8.2E). UAZAPI's own OpenAPI spec documents delivery
-- retries on the webhook endpoint (an `attempts` counter, observed up
-- to at least 3) — unlike the Meta path, a redelivery of the same
-- event is a real, expected possibility here, not just a theoretical
-- one.
--
-- `messages.message_id` was deliberately left non-unique by migration
-- 009 (Meta ids can repeat across *different* numbers/conversations)
-- — this migration does NOT revisit that decision. It adds a
-- SEPARATE, narrower guarantee scoped to (conversation_id,
-- message_id): the same external message id can never land twice in
-- the same conversation. This applies table-wide, so it also covers
-- Meta-sourced rows — safe, because Meta's insert path only ever
-- inserts a given message.id into one conversation once (status
-- updates are UPDATEs, never INSERTs); the duplicate scan below is
-- the actual safety net regardless of that assumption.
--
-- Plain (non-partial) UNIQUE index, by design: Postgres already
-- treats NULL as distinct from NULL in uniqueness checks, so existing
-- rows with no external id (message_id IS NULL) are never blocked by
-- this constraint — no `WHERE message_id IS NOT NULL` predicate
-- needed. Kept plain (not partial) so `uazapi_persist_inbound_text_message`
-- below can target it directly with a plain
-- `ON CONFLICT (conversation_id, message_id)`.
--
-- Safety: this migration NEVER deletes or modifies a single existing
-- row. If (conversation_id, message_id) duplicates already exist
-- (message_id IS NOT NULL), part (a) raises and nothing below it runs
-- — resolve duplicates manually, then rerun. The check only reports a
-- COUNT, never row contents.
-- ============================================================

-- ---- (a) duplicate guard — must run before the index ----------
DO $$
DECLARE
  v_dup_groups INTEGER;
BEGIN
  SELECT count(*) INTO v_dup_groups
  FROM (
    SELECT conversation_id, message_id
    FROM messages
    WHERE message_id IS NOT NULL
    GROUP BY conversation_id, message_id
    HAVING count(*) > 1
  ) dup;

  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION
      'messages has % (conversation_id, message_id) group(s) with a duplicate message_id — resolve manually before applying this migration. No rows were touched.',
      v_dup_groups;
  END IF;
END $$;

-- ---- (b) unique index -------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id
  ON messages (conversation_id, message_id);

-- ---- (c) transactional insert + conversation-advance -------------
--
-- Single function so the message insert and the conversation's
-- last-message/unread summary update happen in exactly one server
-- round trip and one implicit transaction (a plpgsql function body is
-- atomic within the calling statement — no explicit BEGIN/COMMIT
-- needed or possible here). The conversation is only ever touched
-- when the insert actually landed a new row; a redelivery that hits
-- the ON CONFLICT DO NOTHING branch never reaches the UPDATE, so
-- unread_count can never be double-counted and last_message_at/
-- last_message_text can never be clobbered by a retry.
--
-- Deliberately does NOT touch conversations.status or
-- assigned_agent_id — matches the existing Meta webhook convention of
-- never auto-reopening a conversation or reassigning it from an
-- inbound message. No queue/department concept exists yet, so there
-- is nothing routing-related for this function to update either.
--
-- SECURITY INVOKER (not DEFINER): the only caller is the app's
-- service-role client, which already has full table access directly
-- — there is no privilege gap for DEFINER to bridge here, so INVOKER
-- is the more conservative choice (no elevated-privilege function to
-- reason about). search_path is pinned to `public` so this can never
-- be tricked into resolving `messages`/`conversations` from a
-- different schema. No dynamic SQL anywhere in the body.
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

  -- p_occurred_at (the message's own validated timestamp, never NULL
  -- on the normal call path — the parser always produces one, falling
  -- back to its own controlled now() only when the source timestamp
  -- is missing/implausible) drives last_message_at here, not a fresh
  -- now() — etapa 8.2F correction.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      updated_at        = now()
  WHERE id = p_conversation_id;

  -- Guard against a conversation that no longer exists (deleted
  -- between the caller's find-or-create and this call). Without this,
  -- the function would happily report 'persisted' for a message whose
  -- parent conversation was never actually advanced. Raising here
  -- aborts the function's implicit transaction, rolling back the
  -- INSERT above along with it — no orphaned message is left behind.
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_text_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ---- (d) permissions ----------------------------------------------
-- Only the webhook route (service-role client) ever calls this — an
-- authenticated end user or the public must never be able to inject
-- an arbitrary conversation_id/message_id pair into someone else's
-- account's messages via RPC.
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_text_message(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_text_message(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.uazapi_persist_inbound_text_message(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.uazapi_persist_inbound_text_message(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
