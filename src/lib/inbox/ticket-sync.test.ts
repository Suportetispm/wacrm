import { describe, it, expect } from "vitest";
import {
  resolveStatusChangeAction,
  resolveAssignChangeAction,
  statusActionRequest,
  statusActionToastKey,
  assignActionRequest,
  assignActionToastKey,
  type TicketStatusChangeAction,
  type TicketAssignChangeAction,
} from "./ticket-sync";
import type { ActiveConversationTicket } from "@/types";

function ticket(
  overrides: Partial<ActiveConversationTicket> = {},
): ActiveConversationTicket {
  return {
    id: "t1",
    status: "open",
    assigned_agent_id: null,
    queue_id: "q1",
    ...overrides,
  };
}

describe("resolveStatusChangeAction", () => {
  // A) no active ticket -> current direct-UPDATE behavior preserved.
  it("returns 'direct' when there is no active ticket", () => {
    expect(resolveStatusChangeAction(null, "closed")).toEqual({ kind: "direct" });
    expect(resolveStatusChangeAction(undefined, "in_progress")).toEqual({ kind: "direct" });
  });

  // E) waiting_customer -> mark_ticket_waiting_customer, only when the
  // ticket is open and assigned (ticketActionAvailability.waitCustomer).
  it("maps waiting_customer to the waiting_customer RPC when the ticket is open+assigned", () => {
    const action = resolveStatusChangeAction(
      ticket({ status: "open", assigned_agent_id: "agent-1" }),
      "waiting_customer",
    );
    expect(action).toEqual({ kind: "ticket-rpc", op: "waiting_customer" });
  });

  it("marks waiting_customer unavailable when the ticket has no assignee yet", () => {
    const action = resolveStatusChangeAction(
      ticket({ status: "open", assigned_agent_id: null }),
      "waiting_customer",
    );
    expect(action).toEqual({ kind: "unavailable" });
  });

  // F) resume -> resume_ticket, only from a 'pending' ticket.
  it("maps in_progress to resume_ticket when the ticket is pending", () => {
    const action = resolveStatusChangeAction(
      ticket({ status: "pending", assigned_agent_id: "agent-1" }),
      "in_progress",
    );
    expect(action).toEqual({ kind: "ticket-rpc", op: "resume" });
  });

  // G) claim -> claim_ticket, only from an open+unassigned ticket with a queue.
  it("maps in_progress to claim_ticket when the ticket is open and unassigned", () => {
    const action = resolveStatusChangeAction(
      ticket({ status: "open", assigned_agent_id: null, queue_id: "q1" }),
      "in_progress",
    );
    expect(action).toEqual({ kind: "ticket-rpc", op: "claim" });
  });

  it("does not invent a claim when the open ticket already has an assignee", () => {
    // Respects "don't steal the ticket" — this combination is normally
    // unreachable (conversation.status already mirrors 'in_progress'),
    // but must not silently map to any RPC if it ever is.
    const action = resolveStatusChangeAction(
      ticket({ status: "open", assigned_agent_id: "someone-else" }),
      "in_progress",
    );
    expect(action).toEqual({ kind: "unavailable" });
  });

  // C) close uses close_ticket(finalize=false).
  it("maps closed to close_ticket with finalize=false", () => {
    const action = resolveStatusChangeAction(ticket({ status: "open" }), "closed");
    expect(action).toEqual({ kind: "ticket-rpc", op: "close", finalize: false });
  });

  // D) finalized uses close_ticket(finalize=true).
  it("maps finalized to close_ticket with finalize=true", () => {
    const action = resolveStatusChangeAction(ticket({ status: "pending" }), "finalized");
    expect(action).toEqual({ kind: "ticket-rpc", op: "close", finalize: true });
  });

  // I) pending is always unavailable with an active ticket (no
  // transfer_ticket_queue workaround, queue_id stays untouched).
  it("always marks pending unavailable when a ticket is active", () => {
    expect(resolveStatusChangeAction(ticket({ status: "open" }), "pending")).toEqual({
      kind: "unavailable",
    });
    expect(resolveStatusChangeAction(ticket({ status: "pending" }), "pending")).toEqual({
      kind: "unavailable",
    });
  });
});

describe("resolveAssignChangeAction", () => {
  const currentUserId = "agent-1";

  // A) no active ticket -> current direct-UPDATE behavior preserved.
  it("returns 'direct' when there is no active ticket", () => {
    expect(resolveAssignChangeAction(null, "agent-2", currentUserId)).toEqual({
      kind: "direct",
    });
  });

  it("is a no-op when the target agent already matches", () => {
    const t = ticket({ assigned_agent_id: "agent-2" });
    expect(resolveAssignChangeAction(t, "agent-2", currentUserId)).toEqual({ kind: "noop" });
  });

  // G) claim_ticket when unassigned and the caller claims for themself.
  it("maps self-claim on an unassigned ticket to claim_ticket", () => {
    const t = ticket({ assigned_agent_id: null });
    expect(resolveAssignChangeAction(t, currentUserId, currentUserId)).toEqual({
      kind: "ticket-rpc",
      op: "claim",
    });
  });

  it("leaves a direct admin assign onto an unassigned ticket unavailable (documented limitation)", () => {
    const t = ticket({ assigned_agent_id: null });
    expect(resolveAssignChangeAction(t, "agent-2", currentUserId)).toEqual({
      kind: "unavailable",
    });
  });

  // H) transfer-agent uses transfer_ticket_agent.
  it("maps reassigning an already-assigned ticket to a different agent to transfer_ticket_agent", () => {
    const t = ticket({ assigned_agent_id: "agent-2" });
    expect(resolveAssignChangeAction(t, "agent-3", currentUserId)).toEqual({
      kind: "ticket-rpc",
      op: "transfer_agent",
      agentUserId: "agent-3",
    });
  });

  // J) unassign is unavailable with an active ticket.
  it("marks unassign unavailable when the ticket already has an assignee", () => {
    const t = ticket({ assigned_agent_id: "agent-2" });
    expect(resolveAssignChangeAction(t, null, currentUserId)).toEqual({ kind: "unavailable" });
  });
});

describe("statusActionRequest / statusActionToastKey", () => {
  it("builds the right endpoint + body + toast key for each ticket-rpc op", () => {
    const cases: [TicketStatusChangeAction & { kind: "ticket-rpc" }, string, Record<string, unknown>, string][] = [
      [{ kind: "ticket-rpc", op: "waiting_customer" }, "/api/tickets/t1/waiting-customer", {}, "toastWaiting"],
      [{ kind: "ticket-rpc", op: "resume" }, "/api/tickets/t1/resume", {}, "toastResumed"],
      [{ kind: "ticket-rpc", op: "claim" }, "/api/tickets/t1/claim", {}, "toastClaimed"],
      [{ kind: "ticket-rpc", op: "close", finalize: false }, "/api/tickets/t1/close", { finalize: false }, "toastClosed"],
      [{ kind: "ticket-rpc", op: "close", finalize: true }, "/api/tickets/t1/close", { finalize: true }, "toastFinalized"],
    ];
    for (const [action, url, body, toastKey] of cases) {
      expect(statusActionRequest("t1", action)).toEqual({ url, body });
      expect(statusActionToastKey(action)).toBe(toastKey);
    }
  });
});

describe("assignActionRequest / assignActionToastKey", () => {
  it("builds the right endpoint + body + toast key for each ticket-rpc op", () => {
    const claim: TicketAssignChangeAction & { kind: "ticket-rpc" } = { kind: "ticket-rpc", op: "claim" };
    expect(assignActionRequest("t1", claim)).toEqual({ url: "/api/tickets/t1/claim", body: {} });
    expect(assignActionToastKey(claim)).toBe("toastClaimed");

    const transfer: TicketAssignChangeAction & { kind: "ticket-rpc" } = {
      kind: "ticket-rpc",
      op: "transfer_agent",
      agentUserId: "agent-2",
    };
    expect(assignActionRequest("t1", transfer)).toEqual({
      url: "/api/tickets/t1/transfer-agent",
      body: { agent_user_id: "agent-2" },
    });
    expect(assignActionToastKey(transfer)).toBe("toastTransferAgent");
  });
});
