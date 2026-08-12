import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/types";
import { shouldRevertToPending, type LastMessageInfo } from "./auto-status";

/**
 * Thin, testable DB wrappers around the pure rules in auto-status.ts.
 * Every write here is a guarded UPDATE (`.eq('status', <expected>)`,
 * the same compare-and-swap idiom `flows/cron` already uses) rather
 * than a stored procedure — Postgres re-evaluates the WHERE clause
 * against the latest committed row under READ COMMITTED, so two
 * concurrent callers racing the same row can never both "win": the
 * loser's guarded UPDATE simply matches 0 rows.
 *
 * Both functions first check `ticketed_conversation_ids()` (migration
 * 050) and skip any conversation that already has a ticket — those
 * are owned entirely by the tickets.* RPCs (migration 049), never by
 * this module.
 */

async function fetchTicketedConversationIds(
  supabase: SupabaseClient,
): Promise<Set<string> | { error: unknown }> {
  const { data, error } = await supabase.rpc("ticketed_conversation_ids");
  if (error) return { error };
  return new Set((data ?? []) as string[]);
}

// ------------------------------------------------------------
// openPendingConversation
// ------------------------------------------------------------

export type OpenPendingConversationResult =
  /** Was unassigned — now assigned to the caller and in_progress. */
  | { outcome: "claimed"; conversation: Conversation }
  /** Was already assigned to the caller — now in_progress, assignee untouched. */
  | { outcome: "resumed"; conversation: Conversation }
  /**
   * Not applicable: not pending, has a ticket, not found, or — the
   * one case that matters most — pending but already assigned to a
   * DIFFERENT agent (including the case where a concurrent caller won
   * the claim between our checks and now). Status/assignment are left
   * completely untouched; the caller must not assume anything changed.
   */
  | { outcome: "not_applicable" }
  | { outcome: "error"; error: unknown };

/**
 * Agent opens a 'pending' conversation:
 *   - assigned_agent_id IS NULL           → claim (assign to caller, in_progress)
 *   - assigned_agent_id = caller          → resume (in_progress only, assignee untouched)
 *   - assigned_agent_id = someone else    → not_applicable (status AND assignee untouched)
 *
 * The "already assigned to caller" fallback is guarded by
 * `.eq('assigned_agent_id', callerId)` specifically so it can never
 * fire for a conversation assigned to a different agent — attempting
 * both guarded updates in sequence and accepting whichever (if
 * either) matches is what makes the third case a correct no-op
 * without a separate branch: neither guard matches a conversation
 * assigned to someone else.
 */
export async function openPendingConversation(
  supabase: SupabaseClient,
  conversation: Pick<Conversation, "id" | "status">,
  callerId: string,
): Promise<OpenPendingConversationResult> {
  if (conversation.status !== "pending") return { outcome: "not_applicable" };

  const ticketed = await fetchTicketedConversationIds(supabase);
  if ("error" in ticketed) return { outcome: "error", error: ticketed.error };
  if (ticketed.has(conversation.id)) return { outcome: "not_applicable" };

  const claim = await supabase
    .from("conversations")
    .update({ status: "in_progress", assigned_agent_id: callerId })
    .eq("id", conversation.id)
    .eq("status", "pending")
    .is("assigned_agent_id", null)
    .select()
    .maybeSingle();
  if (claim.error) return { outcome: "error", error: claim.error };
  if (claim.data) return { outcome: "claimed", conversation: claim.data as Conversation };

  const resume = await supabase
    .from("conversations")
    .update({ status: "in_progress" })
    .eq("id", conversation.id)
    .eq("status", "pending")
    .eq("assigned_agent_id", callerId)
    .select()
    .maybeSingle();
  if (resume.error) return { outcome: "error", error: resume.error };
  if (resume.data) return { outcome: "resumed", conversation: resume.data as Conversation };

  // Neither guarded UPDATE matched: assigned to a different agent (or
  // someone else won a concurrent claim just now). Untouched by design.
  return { outcome: "not_applicable" };
}

// ------------------------------------------------------------
// sweepStaleConversations
// ------------------------------------------------------------

export interface SweepStaleConversationsResult {
  /** Ids successfully reverted to 'pending'. */
  reverted: string[];
  /** Non-fatal per-row failures — the sweep keeps going past these. */
  errors: { conversationId: string; error: unknown }[];
}

interface CandidateRow {
  id: string;
  status: Conversation["status"];
  messages: LastMessageInfo[] | LastMessageInfo | null;
}

/**
 * Reverts any 'in_progress' conversation whose last message is from
 * the customer and has gone unanswered for
 * `PENDING_REVERT_MINUTES` — see shouldRevertToPending for the exact
 * rule. Conversations with a ticket are skipped (owned by 049).
 *
 * One SELECT (in_progress conversations with their single most recent
 * message embedded, via PostgREST's per-relation order+limit — no
 * N+1) + one RPC (the ticket-id set) + a guarded UPDATE per row that
 * actually qualifies. Called opportunistically (mount, WS reconnect,
 * tab visibility regain, manual refresh, and a light interval) — never
 * a poll shorter than the rule's own 10-minute granularity, and never
 * a full Inbox refetch: this function only ever touches `conversations`
 * rows that qualify, and callers rely on the existing Realtime
 * subscription to reflect the change rather than re-fetching here.
 */
export async function sweepStaleConversations(
  supabase: SupabaseClient,
): Promise<SweepStaleConversationsResult> {
  const now = new Date();

  const [candidatesRes, ticketed] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, status, messages(sender_type, created_at)")
      .eq("status", "in_progress")
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" }),
    fetchTicketedConversationIds(supabase),
  ]);

  if (candidatesRes.error) {
    return { reverted: [], errors: [{ conversationId: "*", error: candidatesRes.error }] };
  }
  if ("error" in ticketed) {
    return { reverted: [], errors: [{ conversationId: "*", error: ticketed.error }] };
  }

  const rows = (candidatesRes.data ?? []) as unknown as CandidateRow[];

  const eligible = rows.filter((row) => {
    if (ticketed.has(row.id)) return false;
    const lastMessage = Array.isArray(row.messages) ? (row.messages[0] ?? null) : row.messages;
    return shouldRevertToPending({ status: row.status }, lastMessage, now);
  });

  const results = await Promise.all(
    eligible.map(async (row) => {
      const { error } = await supabase
        .from("conversations")
        .update({ status: "pending" })
        .eq("id", row.id)
        .eq("status", "in_progress");
      return { id: row.id, error };
    }),
  );

  const reverted: string[] = [];
  const errors: { conversationId: string; error: unknown }[] = [];
  for (const r of results) {
    if (r.error) errors.push({ conversationId: r.id, error: r.error });
    else reverted.push(r.id);
  }

  return { reverted, errors };
}
