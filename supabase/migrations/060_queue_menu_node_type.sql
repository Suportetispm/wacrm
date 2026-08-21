-- ============================================================
-- 060_queue_menu_node_type
--
-- Adds the new `queue_menu` node_type ("Menu de setores" in the
-- builder UI) to the flow_nodes CHECK constraint. This is the ONLY
-- schema change this node needs — queue_menu stores everything else
-- (menu text, options, invalid-reply message, max attempts, optional
-- fallback queue) in flow_nodes.config JSONB, same as every other
-- node type. No new table, no new column on conversations/queues/
-- queue_members/flow_runs.
--
-- queue_menu is a high-level authoring shortcut for the same "triage
-- by menu, route to a setor" shape that collect_input + condition(s)
-- + assign_queue already do manually — it runs through the exact same
-- flow_runs state machine (current_node_key + status='active'), and
-- its attempt counter lives in flow_runs.vars (an existing JSONB
-- column), not a new one. See docs/... (engine.ts's queue_menu
-- handling + handleQueueMenuReply) for the runtime.
--
-- Same drop+recreate pattern as 058_conversation_queue_routing.sql
-- (which added assign_queue to this same CHECK) — the full node_type
-- list below is audited against the TypeScript layer
-- (src/lib/flows/types.ts's FlowNodeConfig union,
-- src/components/flows/shared.tsx's NodeType) so this ADD CONSTRAINT
-- can't silently drift from what the engine/builder actually support.
-- Every node_type accepted by 058 is preserved unchanged, including
-- `http_fetch` (reserved for a v2 node that isn't implemented
-- anywhere yet — see 058's own comment; not touched here either).
--
-- Idempotent — safe to run multiple times. NOT EXECUTED in this
-- revision — pending review before applying to Supabase, same as
-- 059 today.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'assign_queue',
    'queue_menu',
    'handoff',
    'http_fetch',
    'end'
  ));
