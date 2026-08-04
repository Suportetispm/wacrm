-- ============================================================
-- 041_tickets_hotfix
--
-- Hotfix for three real bugs found in 040_tickets.sql's functions
-- AFTER 040 was applied. Contains ONLY function bodies (CREATE OR
-- REPLACE FUNCTION) plus their OWNER/REVOKE/GRANT — no tables,
-- indexes, policies, or triggers are touched. Existing triggers
-- already bound to these function names pick up the corrected
-- bodies automatically; nothing needs to be dropped or recreated.
--
-- Bugs fixed:
--
--   1. open_ticket_for_conversation's INSERT INTO tickets never
--      listed `ticket_number` in its column list, even though
--      v_ticket_number was already computed. tickets.ticket_number
--      is NOT NULL with no DEFAULT, so every call was failing on a
--      NOT NULL violation — no ticket could ever actually be created.
--
--   2. tickets_validate_tenancy (assigned_agent_id/closed_by) and
--      ticket_events_validate_tenancy (actor_user_id) all treated "no
--      profile row found at all" as a silent pass. Unlike
--      conversation_id/queue_id — backed by a real FK to their own
--      table, so "doesn't exist" was already impossible to reach —
--      these three columns are plain FKs to auth.users only; nothing
--      else guaranteed the referenced user had a profile, let alone
--      one in the right account. A user that exists in auth.users
--      but has no profile in ANY account could previously be
--      assigned to a ticket / recorded as a closer / recorded as an
--      event actor without ever being rejected.
--
--   3. open_ticket_for_conversation's `EXCEPTION WHEN unique_violation`
--      handler caught ANY unique violation on `tickets`, not
--      specifically the expected one-active-ticket-per-conversation
--      race. A genuine violation of UNIQUE(account_id, ticket_number)
--      — which should never happen given the atomic counter, but
--      would indicate a real bug if it ever did — would have been
--      silently swallowed and masked as "must have been a
--      conversation race", potentially returning a bogus/empty ticket
--      instead of surfacing the real error.
-- ============================================================

-- ============================================================
-- Fix 2 (part A): tickets_validate_tenancy
-- ============================================================
CREATE OR REPLACE FUNCTION public.tickets_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_account   UUID;
  v_queue_account  UUID;
  v_agent_account  UUID;
  v_closer_account UUID;
BEGIN
  SELECT account_id INTO v_conv_account FROM conversations WHERE id = NEW.conversation_id;
  IF v_conv_account IS NOT NULL AND v_conv_account <> NEW.account_id THEN
    RAISE EXCEPTION 'tickets.conversation_id must reference a conversation in the same account';
  END IF;

  IF NEW.queue_id IS NOT NULL THEN
    SELECT account_id INTO v_queue_account FROM queues WHERE id = NEW.queue_id;
    IF v_queue_account IS NOT NULL AND v_queue_account <> NEW.account_id THEN
      RAISE EXCEPTION 'tickets.queue_id must reference a queue in the same account';
    END IF;
  END IF;

  -- HOTFIX: NOT FOUND now rejected. assigned_agent_id/closed_by are
  -- plain FKs to auth.users only (deliberately, to avoid a composite-
  -- FK + SET NULL conflict with tickets.account_id — see 040's
  -- comments) — no FK anywhere guarantees a profile exists, so this
  -- trigger must reject "no profile at all", not just "profile in a
  -- different account".
  IF NEW.assigned_agent_id IS NOT NULL THEN
    SELECT account_id INTO v_agent_account FROM profiles WHERE user_id = NEW.assigned_agent_id;
    IF NOT FOUND OR v_agent_account <> NEW.account_id THEN
      RAISE EXCEPTION 'tickets.assigned_agent_id must reference a profile in the same account';
    END IF;
  END IF;

  IF NEW.closed_by IS NOT NULL THEN
    SELECT account_id INTO v_closer_account FROM profiles WHERE user_id = NEW.closed_by;
    IF NOT FOUND OR v_closer_account <> NEW.account_id THEN
      RAISE EXCEPTION 'tickets.closed_by must reference a profile in the same account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.tickets_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tickets_validate_tenancy() FROM PUBLIC, anon, authenticated;
-- No GRANT: trigger-only function, never called directly (RETURNS
-- TRIGGER functions can't be invoked via a plain SELECT regardless).

-- ============================================================
-- Fix 2 (part B): ticket_events_validate_tenancy
-- ============================================================
CREATE OR REPLACE FUNCTION public.ticket_events_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account UUID;
  v_actor_account  UUID;
BEGIN
  SELECT account_id INTO v_ticket_account FROM tickets WHERE id = NEW.ticket_id;
  IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
    RAISE EXCEPTION 'ticket_events.ticket_id must reference a ticket in the same account';
  END IF;

  -- HOTFIX: actor_user_id NULL stays allowed (system-generated events
  -- with no human actor, e.g. a future automated timeout closure).
  -- When provided, same "must have a real profile in this account"
  -- guarantee as tickets.assigned_agent_id/closed_by above, for the
  -- same reason — actor_user_id is a plain FK to auth.users only.
  IF NEW.actor_user_id IS NOT NULL THEN
    SELECT account_id INTO v_actor_account FROM profiles WHERE user_id = NEW.actor_user_id;
    IF NOT FOUND OR v_actor_account <> NEW.account_id THEN
      RAISE EXCEPTION 'ticket_events.actor_user_id must reference a profile in the same account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_events_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_events_validate_tenancy() FROM PUBLIC, anon, authenticated;
-- No GRANT: trigger-only function, same reasoning as above.

-- ============================================================
-- Fix 1 + Fix 3: open_ticket_for_conversation
-- ============================================================
CREATE OR REPLACE FUNCTION public.open_ticket_for_conversation(
  p_account_id UUID,
  p_conversation_id UUID,
  p_queue_id UUID,
  p_priority TEXT,
  p_actor_user_id UUID
) RETURNS tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_account UUID;
  v_ticket tickets;
  v_ticket_number BIGINT;
BEGIN
  IF p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'invalid priority: %', p_priority;
  END IF;

  -- 0) Lock the conversation row first — serializes concurrent callers
  --    for the same conversation; also the tenancy gate for
  --    p_conversation_id. Unchanged from 040.
  SELECT account_id INTO v_conv_account
  FROM conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF v_conv_account IS NULL OR v_conv_account <> p_account_id THEN
    RAISE EXCEPTION 'conversation does not belong to the given account';
  END IF;

  -- 1) Idempotent re-entry. Unchanged from 040.
  SELECT * INTO v_ticket
  FROM tickets
  WHERE conversation_id = p_conversation_id
    AND status IN ('open', 'pending')
  LIMIT 1;

  IF FOUND THEN
    RETURN v_ticket;
  END IF;

  -- 2) Atomic sequential number allocation. Unchanged from 040.
  INSERT INTO account_ticket_counters (account_id, next_number)
  VALUES (p_account_id, 2)
  ON CONFLICT (account_id) DO UPDATE
    SET next_number = account_ticket_counters.next_number + 1,
        updated_at = now()
  RETURNING next_number - 1 INTO v_ticket_number;

  -- 3) Create the ticket.
  --    HOTFIX (bug 1): ticket_number is now listed explicitly — the
  --    040 version computed v_ticket_number above and then never used
  --    it here, so every call failed on tickets.ticket_number's NOT
  --    NULL constraint.
  BEGIN
    INSERT INTO tickets (
      account_id,
      conversation_id,
      queue_id,
      ticket_number,
      priority,
      status
    )
    VALUES (
      p_account_id,
      p_conversation_id,
      p_queue_id,
      v_ticket_number,
      p_priority,
      'open'
    )
    RETURNING * INTO v_ticket;
  EXCEPTION WHEN unique_violation THEN
    -- HOTFIX (bug 3): only treat this as the expected
    -- one-active-ticket-per-conversation race if a winning active
    -- ticket for THIS conversation is actually found. A violation of
    -- UNIQUE(account_id, ticket_number) instead (which should never
    -- happen given the atomic counter, but would indicate a real bug
    -- if it ever did) would find nothing here and must never be
    -- silently swallowed — RAISE with no arguments re-raises the
    -- original exception unchanged.
    SELECT * INTO v_ticket
    FROM tickets
    WHERE conversation_id = p_conversation_id
      AND status IN ('open', 'pending')
    LIMIT 1;
    IF FOUND THEN
      RETURN v_ticket;
    END IF;
    RAISE;
  END;

  -- 4) Audit event, same transaction. Unchanged from 040.
  INSERT INTO ticket_events (account_id, ticket_id, event_type, actor_user_id, to_value, payload)
  VALUES (
    p_account_id,
    v_ticket.id,
    'created',
    p_actor_user_id,
    'open',
    jsonb_build_object('ticket_number', v_ticket_number)
  );

  RETURN v_ticket;
END;
$$;

ALTER FUNCTION public.open_ticket_for_conversation(UUID, UUID, UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_ticket_for_conversation(UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_ticket_for_conversation(UUID, UUID, UUID, TEXT, UUID) TO service_role;
