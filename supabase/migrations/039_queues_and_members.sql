-- ============================================================
-- 039_queues_and_members
--
-- Etapa 9.1 — foundational tables for queues (departments) and their
-- members. Deliberately narrow scope: no chatbot tables, no tickets,
-- no whatsapp_config wiring, no changes to contacts/conversations/
-- messages, no webhook changes. Those are separate, later migrations
-- (see docs/uazapi-webhook-progress.md and the etapa 9.0 architecture
-- proposal) — this migration must not create any regression risk for
-- the already-working UAZAPI inbound path.
--
-- Multi-tenant by construction: every row carries account_id, every
-- policy gates on is_account_member(). No table here stores any
-- business text/name specific to one company — greeting/out-of-hours/
-- failure messages are per-row configuration, not hardcoded strings.
--
-- Idempotent — safe to re-run (IF NOT EXISTS / DROP-then-CREATE for
-- policies and triggers, matching every other migration's convention).
-- ============================================================

-- ============================================================
-- QUEUES
-- ============================================================
CREATE TABLE IF NOT EXISTS queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  is_active BOOLEAN NOT NULL DEFAULT true,
  greeting_message TEXT,
  out_of_hours_message TEXT,
  chatbot_max_attempts INTEGER NOT NULL DEFAULT 3
    CHECK (chatbot_max_attempts BETWEEN 1 AND 10),
  chatbot_failure_message TEXT,
  chatbot_failure_action TEXT NOT NULL DEFAULT 'stay_in_queue'
    CHECK (chatbot_failure_action IN ('stay_in_queue', 'remove_queue', 'transfer_queue')),
  -- Plain single-column FK — the "must be same account" guarantee is
  -- enforced by the trigger below, not by a composite FK here.
  --
  -- ON DELETE RESTRICT (not SET NULL): SET NULL would conflict with
  -- the transfer_queue biconditional CHECK below — deleting a queue
  -- that's still referenced by a row configured as
  -- chatbot_failure_action='transfer_queue' would have SET NULL try
  -- to null this column while that CHECK simultaneously requires it
  -- NOT NULL for that action, failing the delete anyway but with a
  -- confusing CHECK-violation error instead of a clear FK one.
  -- RESTRICT makes the real business rule explicit and immediate:
  -- physical deletion is not the normal flow (archival is); a queue
  -- referenced as a transfer target must have that reference removed
  -- or repointed first, deliberately, before it can ever be deleted.
  chatbot_failure_queue_id UUID REFERENCES queues(id) ON DELETE RESTRICT,
  auto_assignment_enabled BOOLEAN NOT NULL DEFAULT false,
  default_wait_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (default_wait_minutes BETWEEN 1 AND 60),
  default_priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL,
  -- Cheap, row-local checks only — cross-row checks (same-account
  -- validation of chatbot_failure_queue_id) can't live in a CHECK
  -- constraint (Postgres CHECK can't query other rows) and are
  -- enforced by the trigger below instead.
  CHECK (chatbot_failure_queue_id IS NULL OR chatbot_failure_queue_id <> id),
  -- Biconditional: a destination queue is required for transfer_queue
  -- and must be ABSENT for every other action — stay_in_queue/
  -- remove_queue must never carry a stale/misleading destination.
  CHECK (
    (chatbot_failure_action = 'transfer_queue' AND chatbot_failure_queue_id IS NOT NULL)
    OR
    (chatbot_failure_action <> 'transfer_queue' AND chatbot_failure_queue_id IS NULL)
  ),
  -- An archived queue is, by definition, not active — prevents the
  -- nonsensical "archived but still active" combination. Deliberately
  -- one-directional: is_active=false alone does NOT require
  -- archived_at (a queue can be paused without being archived).
  CHECK (archived_at IS NULL OR NOT is_active),
  UNIQUE (account_id, name)
);

-- FK target for queue_members' composite tenancy FK below — (id) alone
-- is already unique via the PK, but Postgres requires an explicit
-- unique constraint/index matching the exact composite column set to
-- serve as a composite FK target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queues_id_account
  ON queues(id, account_id);

CREATE INDEX IF NOT EXISTS idx_queues_account ON queues(account_id);
CREATE INDEX IF NOT EXISTS idx_queues_account_active ON queues(account_id, is_active);
CREATE INDEX IF NOT EXISTS idx_queues_failure_queue
  ON queues(chatbot_failure_queue_id)
  WHERE chatbot_failure_queue_id IS NOT NULL;

-- ---- tenancy guard for the self-referencing failure queue ----------
--
-- A plain FK on chatbot_failure_queue_id only guarantees the target
-- row exists somewhere in `queues` — nothing stops it from pointing at
-- another account's queue (FK integrity checks are not subject to
-- RLS, so a malicious/buggy caller could reference an id it can't
-- even SELECT). This trigger is the real, database-level guarantee
-- that "same account" actually means the same account, not just an
-- application-layer convention.
--
-- SECURITY DEFINER (not INVOKER): existence of the target row is the
-- plain FK's job alone — this trigger must only ever reject a row
-- that DOES exist but belongs to a different account, never stand in
-- for "not found" (that stays the FK's error, raised right after this
-- trigger returns). Reliably telling "different account" apart from
-- "doesn't exist" requires seeing the target row's real account_id
-- regardless of the caller's own RLS visibility — an INVOKER-scoped
-- read could be silently blocked by RLS for a row in another account,
-- which would make this trigger blind to exactly the case it exists
-- to catch, while the FK check (which is NOT subject to RLS) would
-- still find the row and let the cross-account reference through.
-- The function does a single, fixed, no-input-beyond-NEW SELECT of
-- one column — minimal, auditable privilege surface for the escalation.
CREATE OR REPLACE FUNCTION public.queues_validate_failure_queue_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_account_id UUID;
BEGIN
  IF NEW.chatbot_failure_queue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id INTO v_target_account_id
  FROM queues
  WHERE id = NEW.chatbot_failure_queue_id;

  -- v_target_account_id IS NULL means "no such queue" — leave that
  -- to the plain FK's own violation error; only raise when the row
  -- was found and its account genuinely differs.
  IF v_target_account_id IS NOT NULL AND v_target_account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'chatbot_failure_queue_id must reference a queue in the same account';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.queues_validate_failure_queue_account() OWNER TO postgres;

-- No role ever needs to CALL this directly — it only runs bound to
-- the trigger below. Revoking EXECUTE doesn't affect that: trigger
-- firing is a DDL-level binding, not a privilege-gated RPC call, and
-- (RETURNS TRIGGER) functions can't be invoked via a plain SELECT
-- regardless. This closes the default PUBLIC EXECUTE grant Postgres
-- adds on every new function, matching this project's convention for
-- every other SECURITY DEFINER function.
REVOKE ALL ON FUNCTION public.queues_validate_failure_queue_account()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_failure_queue_account ON queues;
CREATE TRIGGER validate_failure_queue_account
  BEFORE INSERT OR UPDATE OF chatbot_failure_queue_id, account_id ON queues
  FOR EACH ROW
  EXECUTE FUNCTION public.queues_validate_failure_queue_account();

DROP TRIGGER IF EXISTS set_updated_at ON queues;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON queues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE queues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS queues_select ON queues;
DROP POLICY IF EXISTS queues_insert ON queues;
DROP POLICY IF EXISTS queues_update ON queues;
CREATE POLICY queues_select ON queues FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY queues_insert ON queues FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY queues_update ON queues FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
-- No DELETE policy — physical deletion by `authenticated` is
-- impossible by construction (RLS defaults to deny with no matching
-- policy). Archival is is_active=false / archived_at, never a row
-- delete. Only service_role (which bypasses RLS) can hard-delete, for
-- exceptional administration — mirrors flow_runs/automation_pending_executions.

-- ============================================================
-- PROFILES — composite unique needed as a tenancy FK target
-- ============================================================
--
-- profiles.user_id already has a standalone UNIQUE (migration 001),
-- which makes (user_id, account_id) trivially unique too — but
-- Postgres still requires an explicit unique constraint/index on the
-- *exact* composite column set to allow it as a composite FK target.
-- account_id has been NOT NULL on profiles since migration 017, so
-- this is safe to add without a backfill.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_account
  ON profiles(user_id, account_id);

-- ============================================================
-- QUEUE_MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS queue_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  queue_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_in_queue TEXT NOT NULL DEFAULT 'agent'
    CHECK (role_in_queue IN ('agent', 'supervisor')),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  individual_wait_minutes INTEGER NULL
    CHECK (individual_wait_minutes IS NULL OR individual_wait_minutes BETWEEN 1 AND 60),
  max_active_tickets INTEGER NULL
    CHECK (max_active_tickets IS NULL OR max_active_tickets > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue_id, user_id),
  -- Real, database-level tenancy guarantees (not app-layer trust):
  -- queue_id must belong to a queue row whose account_id matches this
  -- row's own account_id, and user_id must belong to a profile whose
  -- account_id matches too. Both ON DELETE CASCADE — a composite FK's
  -- CASCADE only ever deletes the whole referencing row, never nulls
  -- a subset of columns, so there's no NOT NULL-violation risk here
  -- the way there would be with SET NULL (see queues' self-FK above).
  FOREIGN KEY (queue_id, account_id) REFERENCES queues(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES profiles(user_id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_members_account ON queue_members(account_id);
-- No standalone queue_id index: UNIQUE(queue_id, user_id) below already
-- covers queue_id-only lookups via its leftmost-column prefix — a
-- B-tree index on (queue_id, user_id) serves `WHERE queue_id = X`
-- exactly as well as a dedicated single-column index would. Adding
-- one anyway would only add write cost with no read benefit.
CREATE INDEX IF NOT EXISTS idx_queue_members_user ON queue_members(user_id);
CREATE INDEX IF NOT EXISTS idx_queue_members_queue_active ON queue_members(queue_id, is_active);

DROP TRIGGER IF EXISTS set_updated_at ON queue_members;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON queue_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE queue_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS queue_members_select ON queue_members;
DROP POLICY IF EXISTS queue_members_insert ON queue_members;
DROP POLICY IF EXISTS queue_members_update ON queue_members;
DROP POLICY IF EXISTS queue_members_delete ON queue_members;
CREATE POLICY queue_members_select ON queue_members FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY queue_members_insert ON queue_members FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY queue_members_update ON queue_members FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY queue_members_delete ON queue_members FOR DELETE
  USING (is_account_member(account_id, 'admin'));
