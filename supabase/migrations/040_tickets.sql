-- ============================================================
-- 040_tickets
--
-- Etapa 9.2 — tickets, per-account sequential numbering, and
-- append-only ticket history. Depends on 039 (queues, queue_members,
-- and the composite-FK tenancy infrastructure it added to
-- queues/profiles). Deliberately does NOT touch contacts,
-- conversations, messages, or the UAZAPI webhook/persistence path —
-- those stay exactly as they are; see the "future integration" note
-- at the end of this file for how they'll connect later, in a
-- separate migration.
--
-- Multi-tenant by construction: every row carries account_id, no
-- business text is hardcoded — greeting/failure/close-reason strings
-- are all per-row configuration.
--
-- Idempotent for a genuine re-run of this exact file (IF NOT EXISTS /
-- CREATE OR REPLACE / DROP-then-CREATE for every table/function/
-- trigger/policy). That is NOT the same claim as "safe to apply on
-- top of an earlier, different draft of this migration under the
-- same object names" — CREATE TABLE IF NOT EXISTS does not retroactively
-- alter an already-existing table's columns, FK actions, or CHECK
-- constraints, and CREATE INDEX IF NOT EXISTS only guards the name,
-- not the index definition. This file is meant to be applied exactly
-- once, as a normal sequential migration, per the current design.
-- ============================================================

-- ============================================================
-- ACCOUNT_TICKET_COUNTERS
--
-- One row per account, incremented atomically via UPSERT in
-- open_ticket_for_conversation() below. Never read via SELECT MAX —
-- see that function for the actual allocation statement.
--
-- Not exposed to the client at all: RLS is enabled with zero policies
-- for authenticated/anon (default-deny), so only SECURITY DEFINER
-- functions (running as the table owner) or service_role can ever
-- touch it.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_ticket_counters (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE account_ticket_counters ENABLE ROW LEVEL SECURITY;
-- No policies — authenticated/anon get zero access by default.

-- ============================================================
-- TICKETS
-- ============================================================
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- RESTRICT, not SET NULL: ticket history must never lose its queue
  -- reference silently. A queue with ticket history is expected to be
  -- archived (is_active=false), never physically deleted — RESTRICT
  -- makes that the enforced reality, not just a convention: deleting
  -- a queue that any ticket (open or long-closed) still references is
  -- flatly rejected until every reference is removed or repointed
  -- first, deliberately. Physical queue deletion was already
  -- exceptional/service_role-only per migration 039 (no DELETE policy
  -- for `authenticated`); this makes it exceptional in practice too.
  queue_id UUID NULL REFERENCES queues(id) ON DELETE RESTRICT,
  ticket_number BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- Plain single-column FKs to auth.users (not composite to
  -- profiles) for the same reason as queue_id above: a composite FK's
  -- ON DELETE SET NULL would null every referencing column, including
  -- this row's own NOT NULL account_id. Same-account tenancy for
  -- these is enforced by the trigger below instead, which can use
  -- SET NULL safely because it isn't a declarative FK action.
  assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  closed_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  close_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, ticket_number),
  -- Biconditional: closed_at is required iff status='closed' — same
  -- pattern as queues' transfer_queue/chatbot_failure_queue_id check
  -- in migration 039. closed_by/close_reason are deliberately NEVER
  -- required, even when closed — an automated closure (e.g. a future
  -- timeout sweep) may have no human actor and no stated reason.
  CHECK (
    (status = 'closed' AND closed_at IS NOT NULL)
    OR
    (status <> 'closed' AND closed_at IS NULL)
  ),
  -- Same biconditional shape for pending_at: it means "pending RIGHT
  -- NOW, since this timestamp" — never a stale "was pending once"
  -- marker. A ticket leaving pending (back to open, or to closed) must
  -- clear it in the same UPDATE. Historical "when did this become
  -- pending" belongs in ticket_events (status_changed), not here —
  -- this column's meaning stays unambiguous at every point in time.
  CHECK (
    (status = 'pending' AND pending_at IS NOT NULL)
    OR
    (status <> 'pending' AND pending_at IS NULL)
  )
);

-- Linchpin of "only one active ticket per conversation": a race
-- between two concurrent callers both trying to open a ticket for the
-- same conversation collides here — the loser's INSERT fails with
-- 23505, caught and handled by open_ticket_for_conversation() below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_one_active_per_conversation
  ON tickets(conversation_id)
  WHERE status IN ('open', 'pending');

CREATE INDEX IF NOT EXISTS idx_tickets_account_status ON tickets(account_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_conversation ON tickets(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets(queue_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_opened_at ON tickets(opened_at);

-- ---- tenancy guard: conversation_id / queue_id / assigned_agent_id /
--      closed_by must all belong to the ticket's own account_id -----
--
-- All four are plain single-column FKs (existence + deletion
-- behavior only, per the comments above) — this trigger is the real,
-- database-level "same account" guarantee for all of them, consistent
-- with the tenancy trigger pattern established in migration 039.
--
-- SECURITY DEFINER, for the same reason as 039's
-- queues_validate_failure_queue_account: reliably telling "different
-- account" apart from "doesn't exist" (which stays the plain FK's
-- job — this trigger never raises on a NULL lookup result) requires
-- seeing the target row's true account_id regardless of the caller's
-- own RLS visibility into other accounts' conversations/queues/profiles.
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

  -- Confirms assigned_agent_id has a real profile in this account —
  -- does NOT require queue_membership (assignment doesn't imply queue
  -- membership yet; transfer/assignment rules are a future function).
  IF NEW.assigned_agent_id IS NOT NULL THEN
    SELECT account_id INTO v_agent_account FROM profiles WHERE user_id = NEW.assigned_agent_id;
    IF v_agent_account IS NOT NULL AND v_agent_account <> NEW.account_id THEN
      RAISE EXCEPTION 'tickets.assigned_agent_id must reference a profile in the same account';
    END IF;
  END IF;

  IF NEW.closed_by IS NOT NULL THEN
    SELECT account_id INTO v_closer_account FROM profiles WHERE user_id = NEW.closed_by;
    IF v_closer_account IS NOT NULL AND v_closer_account <> NEW.account_id THEN
      RAISE EXCEPTION 'tickets.closed_by must reference a profile in the same account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.tickets_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tickets_validate_tenancy() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_tenancy ON tickets;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT OR UPDATE OF conversation_id, queue_id, assigned_agent_id, closed_by, account_id ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.tickets_validate_tenancy();

DROP TRIGGER IF EXISTS set_updated_at ON tickets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tickets_select ON tickets;
DROP POLICY IF EXISTS tickets_update ON tickets;
-- SELECT is the ONLY policy on this table for `authenticated` — see
-- below for why INSERT/UPDATE/DELETE are all deliberately absent.
--
-- owner/admin/viewer see every ticket in the account; agent sees only
-- tickets assigned to them or in a queue they belong to. Viewer is
-- deliberately grouped with admin/owner (NOT with agent) — every
-- other table in this project treats viewer as full read-only
-- oversight (contacts/conversations/tags/queues all grant
-- is_account_member(account_id) for SELECT with no further scoping);
-- scoping viewer down to "my assigned tickets" would show a viewer
-- nothing, since viewers are never assigned tickets. Confirmed
-- explicitly for this etapa: viewer can see every ticket in the
-- account, and can never insert/update/delete a ticket or execute any
-- mutating RPC — the second half of that is enforced below (no
-- policy grants viewer, or anyone else in `authenticated`, any write
-- at all; open_ticket_for_conversation's EXECUTE grant is service_role
-- only, so no authenticated session — viewer or otherwise — can invoke
-- it directly either).
CREATE POLICY tickets_select ON tickets FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
    OR (
      is_account_member(account_id, 'agent') AND NOT is_account_member(account_id, 'admin')
      AND (
        assigned_agent_id = auth.uid()
        -- Untriaged tickets (queue_id IS NULL) fall through this
        -- EXISTS naturally — `qm.queue_id = NULL` is never true in
        -- SQL, so a plain agent can only see one via the
        -- assigned_agent_id branch above, never by queue membership.
        -- No triage/default-queue behavior is introduced by this
        -- migration; queue_id is whatever the caller of
        -- open_ticket_for_conversation passes, NULL included.
        OR EXISTS (
          SELECT 1 FROM queue_members qm
          WHERE qm.queue_id = tickets.queue_id
            AND qm.user_id = auth.uid()
            AND qm.account_id = tickets.account_id
        )
      )
    )
  );
-- No INSERT policy: tickets are only ever created through
-- open_ticket_for_conversation() below (SECURITY DEFINER, bypasses
-- RLS as the table owner) — this is what guarantees every ticket gets
-- a real sequential number, the active-ticket dedup check, and a
-- 'created' event, instead of a raw client insert skipping all three.
--
-- No UPDATE policy, on this pass deliberately: an RLS policy can gate
-- WHICH ROWS a caller may touch, but not WHICH COLUMNS — a `USING`/
-- `WITH CHECK` clause permissive enough to let an agent change
-- `status` would, by the same clause, let that same agent freely
-- rewrite `priority`, `queue_id`, `assigned_agent_id`, or anything
-- else on that row via a raw PostgREST PATCH, with no ticket_events
-- row ever recorded — silently defeating the audit trail this
-- migration exists to guarantee. Status/queue/priority/assignment
-- changes are deferred to future SECURITY DEFINER functions (mirroring
-- open_ticket_for_conversation) that change exactly the intended
-- columns AND write the matching ticket_events row in the same
-- transaction — not a REST UPDATE.
--
-- No DELETE policy — tickets are permanent history, never deleted by
-- `authenticated`.

-- ============================================================
-- TICKET_EVENTS — append-only audit trail
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created',
    'status_changed',
    'priority_changed',
    'assigned',
    'transferred_queue',
    'transferred_agent',
    'closed',
    'reopened'
  )),
  actor_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  from_value TEXT NULL,
  to_value TEXT NULL,
  -- Small structured metadata only (e.g. {"ticket_number": 42}) — a
  -- policy for future writers, not DB-enforced: this column must
  -- never receive secrets/tokens or the full text of a customer
  -- message. This table is readable by every account member with
  -- ticket visibility (see ticket_events_select below), unlike the
  -- server-only logs elsewhere in this codebase.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ticket_id already implies account via `tickets`, but account_id is
-- carried directly here too (denormalized) so the SELECT policy below
-- and future reporting queries don't need a join just to filter by
-- tenancy. Trigger-validated, same reasoning as `tickets` above.
CREATE OR REPLACE FUNCTION public.ticket_events_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account UUID;
BEGIN
  SELECT account_id INTO v_ticket_account FROM tickets WHERE id = NEW.ticket_id;
  IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
    RAISE EXCEPTION 'ticket_events.ticket_id must reference a ticket in the same account';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_events_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_events_validate_tenancy() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_tenancy ON ticket_events;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT ON ticket_events
  FOR EACH ROW
  EXECUTE FUNCTION public.ticket_events_validate_tenancy();

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
  ON ticket_events(ticket_id, created_at DESC);

ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_events_select ON ticket_events;
-- Same visibility as the parent ticket (mirrors tickets_select).
CREATE POLICY ticket_events_select ON ticket_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tickets t
      WHERE t.id = ticket_events.ticket_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (is_account_member(t.account_id) AND NOT is_account_member(t.account_id, 'agent'))
          OR (
            is_account_member(t.account_id, 'agent') AND NOT is_account_member(t.account_id, 'admin')
            AND (
              t.assigned_agent_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM queue_members qm
                WHERE qm.queue_id = t.queue_id
                  AND qm.user_id = auth.uid()
                  AND qm.account_id = t.account_id
              )
            )
          )
        )
    )
  );
-- No INSERT/UPDATE/DELETE policies for authenticated — append-only,
-- writes only via SECURITY DEFINER functions or service_role. History
-- can never be edited or removed through the interface.

-- ============================================================
-- open_ticket_for_conversation — the only sanctioned ticket-creation
-- path. Idempotent re-entry (returns the existing active ticket if
-- one is already open/pending), atomic sequential numbering (no
-- SELECT MAX), and the 'created' audit event, all in ONE function
-- call / ONE transaction.
--
-- RETURNS tickets (a composite row type, not SETOF): PostgREST
-- returns this as a single JSON OBJECT in `data` — one row's columns
-- as keys — never an array. This differs from every other RPC in
-- this codebase so far (e.g. redeem_invitation RETURNS UUID, a bare
-- scalar, so its `data` is the raw string). This is the first
-- row-returning RPC here; not exercised by any route yet (none is
-- created in this migration). When a route is written, it MUST
-- treat `error` non-null OR a `data` that isn't a well-formed object
-- with at least `id`, `ticket_number`, and `status` present as a
-- failure — never assume an unexpected shape means success, the same
-- discipline already applied to uazapi_persist_inbound_text_message's
-- 'persisted'/'duplicate' string check.
--
-- SECURITY DEFINER: required for four independent reasons —
--   1. account_ticket_counters has zero client-facing policies by
--      design; only the table owner (or service_role) can write it.
--   2. Tenancy validation of p_conversation_id must see the true
--      conversation row regardless of the caller's own RLS
--      visibility (same reasoning as the triggers above).
--   3. tickets has no client INSERT policy at all — this function IS
--      the insert path, run as owner.
--   4. Step 0 below takes SELECT ... FOR UPDATE on `conversations` —
--      an owner-run lock is unaffected by that table's own RLS.
-- search_path pinned, no dynamic SQL anywhere in the body.
--
-- Concurrency design: two concurrent calls for the SAME conversation
-- must never both consume a ticket_number. `SELECT ... FOR UPDATE` on
-- the conversation row (a real row lock, not an advisory lock — the
-- row already exists, is already the natural point of serialization
-- for "this conversation", and needs no extra bookkeeping) makes the
-- second caller block until the first commits; once unblocked, its
-- own active-ticket check (step 1, now AFTER the lock) sees the
-- first caller's committed ticket and returns it without ever
-- touching the counter. idx_tickets_one_active_per_conversation stays
-- in place as a second, independent line of defense — e.g. against a
-- hypothetical future caller that reaches the INSERT some other way
-- without going through this lock — but the normal path through this
-- function no longer relies on it to avoid burning a number.
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

  -- 0) Lock the conversation row FIRST, before checking for an active
  --    ticket or touching the counter — this is what serializes
  --    concurrent callers for the same conversation. Also doubles as
  --    the tenancy gate: p_conversation_id must actually belong to
  --    p_account_id. (queue_id/assigned_agent_id/closed_by tenancy is
  --    covered uniformly for every write path, including the INSERT
  --    below, by the tickets_validate_tenancy trigger instead.)
  SELECT account_id INTO v_conv_account
  FROM conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF v_conv_account IS NULL OR v_conv_account <> p_account_id THEN
    RAISE EXCEPTION 'conversation does not belong to the given account';
  END IF;

  -- 1) Idempotent re-entry, now that the lock is held: if a concurrent
  --    caller got here first, its ticket is already committed and
  --    visible here the instant this SELECT runs post-lock — return
  --    it, no counter ever touched by this call.
  SELECT * INTO v_ticket
  FROM tickets
  WHERE conversation_id = p_conversation_id
    AND status IN ('open', 'pending')
  LIMIT 1;

  IF FOUND THEN
    RETURN v_ticket;
  END IF;

  -- 2) Only now — no active ticket exists, and no concurrent caller
  --    for this conversation can be racing us (the lock excludes
  --    them) — allocate the next sequential number for this account,
  --    atomically, in one statement. Never SELECT MAX(ticket_number).
  --    The UPSERT handles both "first ticket ever for this account"
  --    (INSERT branch: seeds next_number at 2, returns 2-1=1) and the
  --    ordinary case (DO UPDATE branch: increments and returns the
  --    pre-increment value) with the same statement. This UPSERT's
  --    own row lock is what keeps DIFFERENT conversations in the SAME
  --    account independent while still getting distinct numbers —
  --    the conversation-row lock above only ever serializes same-
  --    conversation callers; cross-conversation concurrency is safe
  --    here exactly as it always was.
  INSERT INTO account_ticket_counters (account_id, next_number)
  VALUES (p_account_id, 2)
  ON CONFLICT (account_id) DO UPDATE
    SET next_number = account_ticket_counters.next_number + 1,
        updated_at = now()
  RETURNING next_number - 1 INTO v_ticket_number;

  -- 3) Create the ticket. The conversation lock from step 0 means no
  --    concurrent same-conversation caller can reach this INSERT
  --    before we commit — idx_tickets_one_active_per_conversation
  --    should never actually fire on this path anymore. It stays as
  --    defense in depth (see the function-level comment above); this
  --    EXCEPTION block is what makes that defense real rather than
  --    theoretical, at no extra cost on the normal path.
  BEGIN
    INSERT INTO tickets (account_id, conversation_id, queue_id, priority, status)
    VALUES (p_account_id, p_conversation_id, p_queue_id, p_priority, 'open')
    RETURNING * INTO v_ticket;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_ticket
    FROM tickets
    WHERE conversation_id = p_conversation_id
      AND status IN ('open', 'pending')
    LIMIT 1;
    RETURN v_ticket;
  END;

  -- 4) Audit event, same transaction as the ticket insert and the
  --    counter allocation. Any failure here (including a future
  --    tenancy trigger rejecting actor_user_id, or a constraint on
  --    ticket_events) is NOT caught by any EXCEPTION block at this
  --    point in the function, so it propagates and aborts the whole
  --    call — the ticket INSERT and the counter UPSERT above are
  --    rolled back with it. A ticket can never exist without its
  --    'created' event, and a counter value can never be consumed
  --    for a ticket that didn't actually get created.
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

-- ============================================================
-- FUTURE INTEGRATION (not implemented in this migration)
--
-- messages.ticket_id — proposed shape for a separate, later
-- migration, once tickets have been exercised in production:
--   ALTER TABLE messages ADD COLUMN ticket_id UUID NULL
--     REFERENCES tickets(id) ON DELETE SET NULL;
--   CREATE INDEX idx_messages_ticket ON messages(ticket_id);
-- Nullable, no backfill, no NOT NULL — old messages stay untagged
-- forever; only new inserts would populate it going forward.
--
-- Inbound flow once that column exists:
--   webhook receives message
--     → uazapi_persist_inbound_text_message() persists contact/
--       conversation/message exactly as it does today (UNCHANGED)
--     → a NEW, separate step calls open_ticket_for_conversation()
--       to get-or-create the active ticket for that conversation
--     → the message row (or a follow-up UPDATE) is stamped with
--       that ticket's id
-- This migration changes NONE of that today — messages, conversations,
-- uazapi_persist_inbound_text_message, and the webhook route are all
-- untouched.
--
-- One interaction to plan for when that wiring happens:
-- open_ticket_for_conversation's step 0 takes `SELECT ... FOR UPDATE`
-- on the conversation row; uazapi_persist_inbound_text_message's
-- conversation-advance UPDATE also touches that same row. If both
-- ever run concurrently for the same conversation, one briefly waits
-- for the other's row lock to release — expected, safe (both paths
-- only ever lock one row each, so no lock-ordering deadlock is
-- possible), and not a concern this migration needs to address, but
-- worth knowing before wiring the two together.
-- ============================================================
