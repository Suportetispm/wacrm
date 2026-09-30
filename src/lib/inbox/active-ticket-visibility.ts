import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Closes the residual risk documented at the end of Etapa 2 of the
 * Inbox ↔ Tickets sync: `conversation.active_ticket` (the
 * CONVERSATION_SELECT embed, src/lib/inbox/conversations.ts) is
 * subject to `tickets_select` RLS — an agent who can see the
 * conversation (via its own queue) but isn't the ticket's assignee nor
 * a member of the ticket's OWN queue (a deliberately different field,
 * see 068's transfer_ticket_queue comment) gets `active_ticket: null`
 * even when an active ticket genuinely exists. Etapa 2's decision
 * logic (ticket-sync.ts) would then treat that as "no active ticket"
 * and fall back to the direct `conversations` UPDATE — reintroducing
 * the exact divergence the etapa exists to prevent, just for that
 * narrower slice of agents.
 *
 * This module separates "does an active ticket exist" from "can I see
 * its details", per migration 069's
 * `conversation_has_active_ticket(uuid)` RPC — a SECURITY DEFINER
 * boolean-only existence check, deliberately not reusing
 * `ticketed_conversation_ids()` (050) since that one considers ANY
 * ticket status, not just active (open/pending) ones — see 069's own
 * comment for the full audit.
 */

export type ActiveTicketVisibility =
  | "no_active_ticket"
  | "active_ticket_visible"
  | "active_ticket_hidden";

/**
 * Pure 3-state classification. `hasVisibleActiveTicket` is whether
 * `conversation.active_ticket` came back non-null from the RLS-scoped
 * embed; `hasActiveTicketAuthoritative` is the RLS-independent RPC's
 * answer (only meaningful — and only ever consulted — when the embed
 * saw nothing, see {@link resolveActiveTicketVisibility}).
 */
export function classifyActiveTicketVisibility(
  hasVisibleActiveTicket: boolean,
  hasActiveTicketAuthoritative: boolean,
): ActiveTicketVisibility {
  if (hasVisibleActiveTicket) return "active_ticket_visible";
  return hasActiveTicketAuthoritative
    ? "active_ticket_hidden"
    : "no_active_ticket";
}

/**
 * Resolves the 3-state visibility for one conversation, making the
 * `conversation_has_active_ticket` round-trip only when the embed
 * already came back empty — a visible active ticket already answers
 * the question by itself, so the common case (admin/owner, or an
 * agent who's the ticket's own assignee) never pays for the extra
 * query.
 *
 * Returns `"check_failed"` — never a guessed state — when the RPC
 * itself errors (network/DB issue), so callers can fail closed (block
 * the action) instead of silently treating "couldn't tell" as "no
 * active ticket".
 */
export async function resolveActiveTicketVisibility(
  supabase: SupabaseClient,
  conversationId: string,
  hasVisibleActiveTicket: boolean,
): Promise<ActiveTicketVisibility | "check_failed"> {
  if (hasVisibleActiveTicket) return "active_ticket_visible";

  const { data, error } = await supabase.rpc("conversation_has_active_ticket", {
    p_conversation_id: conversationId,
  });

  if (error) {
    console.error("Failed to check for a hidden active ticket:", error);
    return "check_failed";
  }

  return classifyActiveTicketVisibility(false, Boolean(data));
}
