-- ============================================================
-- 061_inbound_message_trigger_type
--
-- Adds the new `inbound_message` trigger_type ("Qualquer mensagem
-- recebida" in the builder UI) to the flows CHECK constraint.
--
-- Existing trigger types:
--   - keyword: matches on a customer text.
--   - first_inbound_message: fires only on the contact/conversation's
--     FIRST customer message (isFirstInboundMessage — counts prior
--     'customer' rows on the conversation before the current insert).
--   - manual: never auto-starts from inbound.
--
-- inbound_message is a broader triage entry point: it fires on ANY
-- inbound text on a conversation that hasn't been routed yet —
-- new contact or one with a full message history alike — as long as
-- conversations.queue_id IS NULL AND assigned_agent_id IS NULL. This
-- removes the "only the very first message" restriction that made
-- first_inbound_message unusable for a contact re-engaging an old,
-- never-routed conversation, or a contact that already existed in the
-- account (imported, manually created) before ever messaging in.
--
-- No schema change beyond this CHECK: the "not yet routed" gate reads
-- existing conversations.queue_id/assigned_agent_id columns (never
-- writes them), the "one active run" invariant is still the existing
-- partial unique index `idx_one_active_run_per_contact` (migration
-- 017), and eligible-flow ordering is still `created_at ASC` — same
-- resolution rule every trigger_type already shares in
-- findEntryFlow (engine.ts), not a new priority system.
--
-- first_inbound_message is UNCHANGED and stays available — this
-- migration only WIDENS the accepted set, it doesn't touch any
-- existing flow row or migrate anyone's trigger_type.
--
-- Same drop+recreate pattern as 058/060 (which extended
-- flow_nodes_node_type_check) — the unnamed inline CHECK from
-- 010_flows.sql is Postgres-auto-named `flows_trigger_type_check`;
-- never renamed/touched by any migration since.
--
-- Idempotent — safe to run multiple times. NOT EXECUTED in this
-- revision — pending review before applying to Supabase, same as
-- 059/060 today. Does NOT edit 058, 059, or 060.
-- ============================================================

ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN (
    'keyword',
    'first_inbound_message',
    'inbound_message',
    'manual'
  ));
