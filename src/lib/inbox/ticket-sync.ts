import { ticketActionAvailability } from "@/lib/tickets/status";
import type { ActiveConversationTicket, ConversationStatus } from "@/types";

/**
 * Pure decision rules for the Inbox ↔ Tickets sync gap (migration 068's
 * Etapa 2). When a conversation has no active ticket
 * (tickets.status IN ('open','pending')), the Inbox keeps writing
 * `conversations` directly — unchanged from before this module existed.
 * When it DOES have one, a raw `conversations` UPDATE could diverge from
 * the ticket (the RPCs in 049/068 are the only writers that keep both in
 * sync), so status/assignment changes must route through the matching
 * ticket RPC instead — or be refused when there is no safe RPC for the
 * requested change ("não inventar comportamento" per the etapa's brief).
 *
 * These functions never touch the network; message-thread.tsx is the
 * only caller, and decides what to actually fetch based on the `kind`
 * returned here. `ticketActionAvailability` (src/lib/tickets/status.ts,
 * already used by the /tickets UI) is reused rather than re-deriving the
 * same open/pending/assigned rules a second time.
 */

export type TicketStatusChangeAction =
  /** No active ticket — proceed with the existing direct UPDATE. */
  | { kind: "direct" }
  /** Active ticket, but no safe RPC maps to this target status. */
  | { kind: "unavailable" }
  | { kind: "ticket-rpc"; op: "waiting_customer" }
  | { kind: "ticket-rpc"; op: "resume" }
  | { kind: "ticket-rpc"; op: "claim" }
  | { kind: "ticket-rpc"; op: "close"; finalize: boolean };

/**
 * Maps a status the Inbox's dropdown wants to move a conversation to,
 * onto the ticket RPC that can safely do it while an active ticket
 * exists. Only the combinations explicitly called out in the etapa are
 * mapped:
 *
 *   waiting_customer              → mark_ticket_waiting_customer
 *   in_progress, ticket 'pending' → resume_ticket
 *   in_progress, ticket 'open'
 *     and unassigned              → claim_ticket
 *   closed                        → close_ticket(finalize=false)
 *   finalized                     → close_ticket(finalize=true)
 *   pending                       → always unavailable (would require
 *                                    transfer_ticket_queue as a
 *                                    workaround, touching queue_id —
 *                                    explicitly out of scope)
 *
 * Anything else (e.g. `in_progress` requested while the ticket is
 * already 'open' AND assigned — normally unreachable, since
 * conversations.status already mirrors that as 'in_progress' and the
 * caller short-circuits on no-op targets) falls back to `unavailable`
 * rather than guessing.
 */
export function resolveStatusChangeAction(
  activeTicket: ActiveConversationTicket | null | undefined,
  targetStatus: ConversationStatus,
): TicketStatusChangeAction {
  if (!activeTicket) return { kind: "direct" };

  const avail = ticketActionAvailability({
    status: activeTicket.status,
    assigned_agent_id: activeTicket.assigned_agent_id,
    queue_id: activeTicket.queue_id,
  });

  switch (targetStatus) {
    case "waiting_customer":
      return avail.waitCustomer
        ? { kind: "ticket-rpc", op: "waiting_customer" }
        : { kind: "unavailable" };
    case "in_progress":
      if (activeTicket.status === "pending" && avail.resume) {
        return { kind: "ticket-rpc", op: "resume" };
      }
      if (activeTicket.status === "open" && avail.claim) {
        return { kind: "ticket-rpc", op: "claim" };
      }
      return { kind: "unavailable" };
    case "closed":
      return avail.close
        ? { kind: "ticket-rpc", op: "close", finalize: false }
        : { kind: "unavailable" };
    case "finalized":
      return avail.close
        ? { kind: "ticket-rpc", op: "close", finalize: true }
        : { kind: "unavailable" };
    case "pending":
      return { kind: "unavailable" };
  }
}

/** POST endpoint + body for a resolved `{ kind: "ticket-rpc" }` status action. */
export function statusActionRequest(
  ticketId: string,
  action: TicketStatusChangeAction & { kind: "ticket-rpc" },
): { url: string; body: Record<string, unknown> } {
  switch (action.op) {
    case "waiting_customer":
      return { url: `/api/tickets/${ticketId}/waiting-customer`, body: {} };
    case "resume":
      return { url: `/api/tickets/${ticketId}/resume`, body: {} };
    case "claim":
      return { url: `/api/tickets/${ticketId}/claim`, body: {} };
    case "close":
      return {
        url: `/api/tickets/${ticketId}/close`,
        body: { finalize: action.finalize },
      };
  }
}

/** `Tickets.actions` i18n key for the success toast of a status action. */
export function statusActionToastKey(
  action: TicketStatusChangeAction & { kind: "ticket-rpc" },
): "toastWaiting" | "toastResumed" | "toastClaimed" | "toastClosed" | "toastFinalized" {
  switch (action.op) {
    case "waiting_customer":
      return "toastWaiting";
    case "resume":
      return "toastResumed";
    case "claim":
      return "toastClaimed";
    case "close":
      return action.finalize ? "toastFinalized" : "toastClosed";
  }
}

export type TicketAssignChangeAction =
  /** No active ticket — proceed with the existing direct UPDATE. */
  | { kind: "direct" }
  /** Requested agent already matches — nothing to do. */
  | { kind: "noop" }
  /** Active ticket, but no safe RPC maps to this reassignment. */
  | { kind: "unavailable" }
  | { kind: "ticket-rpc"; op: "claim" }
  | { kind: "ticket-rpc"; op: "transfer_agent"; agentUserId: string };

/**
 * Maps an assignee change the Inbox wants onto the ticket RPC that can
 * safely do it while an active ticket exists:
 *
 *   unassigned  → self          → claim_ticket
 *   unassigned  → someone else  → unavailable (admin direct-assign to a
 *                                  third party has no RPC yet — documented
 *                                  limitation, not invented here)
 *   assigned    → null (unassign) → unavailable (no safe equivalent)
 *   assigned    → a different agent → transfer_ticket_agent
 *   assigned    → same agent again  → noop
 */
export function resolveAssignChangeAction(
  activeTicket: ActiveConversationTicket | null | undefined,
  targetAgentId: string | null,
  currentUserId: string | null,
): TicketAssignChangeAction {
  if (!activeTicket) return { kind: "direct" };
  if (targetAgentId === activeTicket.assigned_agent_id) return { kind: "noop" };

  if (!activeTicket.assigned_agent_id) {
    if (targetAgentId && targetAgentId === currentUserId) {
      return { kind: "ticket-rpc", op: "claim" };
    }
    return { kind: "unavailable" };
  }

  if (targetAgentId === null) return { kind: "unavailable" };
  return { kind: "ticket-rpc", op: "transfer_agent", agentUserId: targetAgentId };
}

/** POST endpoint + body for a resolved `{ kind: "ticket-rpc" }` assign action. */
export function assignActionRequest(
  ticketId: string,
  action: TicketAssignChangeAction & { kind: "ticket-rpc" },
): { url: string; body: Record<string, unknown> } {
  switch (action.op) {
    case "claim":
      return { url: `/api/tickets/${ticketId}/claim`, body: {} };
    case "transfer_agent":
      return {
        url: `/api/tickets/${ticketId}/transfer-agent`,
        body: { agent_user_id: action.agentUserId },
      };
  }
}

/** `Tickets.actions` i18n key for the success toast of an assign action. */
export function assignActionToastKey(
  action: TicketAssignChangeAction & { kind: "ticket-rpc" },
): "toastClaimed" | "toastTransferAgent" {
  return action.op === "claim" ? "toastClaimed" : "toastTransferAgent";
}
