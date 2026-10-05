import { beforeEach, describe, expect, it, vi } from "vitest";

// Fase 1A.1 — Robustez do Flow, Trabalho 1: `handoff.assign_to` never
// trusted at face value. Mirrors engine.assign-queue.test.ts's
// in-memory Supabase fake (no real Postgres) — this file exercises the
// new `resolveHandoffAssignee` re-check the same way that file
// exercises `resolveAndAssignQueue`: full node execution (start →
// handoff) against seeded `profiles` rows, never the pure function in
// isolation, so a regression in how engine.ts WIRES the check would
// still be caught.

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn().mockResolvedValue({ whatsapp_message_id: "wamid-fixture" }),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));

// ============================================================
// Minimal in-memory fake of the Supabase query builder — just enough
// of select/insert/update/eq/is/order/limit/maybeSingle to drive the
// engine's real code paths without a real Postgres. Copied from
// engine.assign-queue.test.ts (each engine.*.test.ts file in this repo
// keeps its own copy rather than sharing one, so a change to one
// scenario's seed data can never ripple into another file).
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function createMockDb(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    accounts: seed.accounts ?? [{ id: "acct-1", is_active: true }],
    flows: seed.flows ?? [],
    flow_nodes: seed.flow_nodes ?? [],
    flow_runs: seed.flow_runs ?? [],
    flow_run_events: seed.flow_run_events ?? [],
    profiles: seed.profiles ?? [],
    conversations: seed.conversations ?? [],
    messages: seed.messages ?? [],
  };

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const filters: Array<(r: Row) => boolean> = [];
    let orderKey: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let mode: "select" | "insert" | "update" = "select";
    let insertPayload: Row | null = null;
    let updatePayload: Row | null = null;

    function applyFilters(list: Row[]) {
      let out = list.filter((r) => filters.every((f) => f(r)));
      if (orderKey) {
        const key = orderKey;
        out = [...out].sort((a, b) => {
          if (a[key] === b[key]) return 0;
          return (a[key] < b[key] ? -1 : 1) * (orderAsc ? 1 : -1);
        });
      }
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    }

    function resolve(): { data: unknown; error: { message: string } | null } {
      if (mode === "insert") {
        const record: Row = { id: `${table}-${rows.length + 1}`, ...insertPayload };
        if (table === "flow_runs" && record.status === "active") {
          const clash = rows.find(
            (r) => r.status === "active" && r.account_id === record.account_id && r.contact_id === record.contact_id,
          );
          if (clash) {
            return { data: null, error: { message: "duplicate key value violates unique constraint (23505)" } };
          }
        }
        rows.push(record);
        return { data: record, error: null };
      }
      if (mode === "update") {
        const matched = applyFilters(rows);
        for (const r of matched) Object.assign(r, updatePayload);
        return { data: matched, error: null };
      }
      return { data: applyFilters(rows), error: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: () => builder,
      insert: (payload: Row) => {
        mode = "insert";
        insertPayload = payload;
        return builder;
      },
      update: (payload: Row) => {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      filter: () => builder,
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderKey = col;
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: async () => {
        const { data, error } = resolve();
        if (error) return { data: null, error };
        const list = Array.isArray(data) ? data : [data];
        return { data: list[0] ?? null, error: null };
      },
      single: async () => {
        const { data, error } = resolve();
        if (error) return { data: null, error };
        const list = Array.isArray(data) ? data : [data];
        return { data: list[0] ?? null, error: null };
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    };
    return builder;
  }

  return {
    from,
    tables,
    // increment_flow_execution_count (startNewRun) — no counters
    // asserted in these tests, just needs to resolve cleanly.
    rpc: async () => ({ data: null, error: null }),
  };
}

let mockDb: ReturnType<typeof createMockDb>;

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => mockDb,
}));

import { dispatchInboundToFlows } from "./engine";

// ------------------------------------------------------------
// Shared fixtures — the simplest possible flow that reaches a
// `handoff` node on the very first inbound message: start -> handoff.
// ------------------------------------------------------------

const FLOW_ID = "flow-1";
const ACCOUNT_A = "acct-1";
const ACCOUNT_B = "acct-2";

function handoffFlow(overrides: Partial<Row> = {}): Row {
  return {
    id: FLOW_ID,
    account_id: ACCOUNT_A,
    user_id: "user-1",
    name: "Escalate",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: {},
    entry_node_id: "start",
    fallback_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function handoffNodes(assign_to?: string): Row[] {
  return [
    { id: "n-start", flow_id: FLOW_ID, node_key: "start", node_type: "start", config: { next_node_key: "ho" } },
    {
      id: "n-handoff",
      flow_id: FLOW_ID,
      node_key: "ho",
      node_type: "handoff",
      config: assign_to ? { assign_to, note: "escalated" } : { note: "escalated" },
    },
  ];
}

function dispatch(convId = "conv-1") {
  return dispatchInboundToFlows({
    accountId: ACCOUNT_A,
    userId: "user-1",
    contactId: "contact-1",
    conversationId: convId,
    queueId: null,
    assignedAgentId: null,
    message: { kind: "text", text: "Preciso de ajuda", meta_message_id: "m1" },
    isFirstInboundMessage: true,
  });
}

beforeEach(() => {
  mockDb = createMockDb();
});

describe("handoff.assign_to — server-side tenancy/is_active re-validation (never trusts node.config)", () => {
  it("valid: an active member of the SAME account is assigned — behavior unchanged from before this guard", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes("agent-1");
    mockDb.tables.profiles = [{ user_id: "agent-1", account_id: ACCOUNT_A, is_active: true }];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: "q-untouched", assigned_agent_id: null }];

    const result = await dispatch();

    expect(result.consumed).toBe(true);
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.assigned_agent_id).toBe("agent-1");
    expect(conv?.status).toBe("pending");
    // queue_id is never part of this node's blast radius, valid or not.
    expect(conv?.queue_id).toBe("q-untouched");
    const run = mockDb.tables.flow_runs.find((r: Row) => r.flow_id === FLOW_ID);
    expect(run?.status).toBe("handed_off");
    const event = mockDb.tables.flow_run_events.find((e: Row) => e.event_type === "handoff");
    expect(event?.payload?.assigned_to).toBe("agent-1");
  });

  it("nonexistent user: never written, handoff still completes (fail-safe, not fail-closed on the whole node)", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes("ghost-user");
    mockDb.tables.profiles = []; // no such profile anywhere
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatch();

    expect(result.consumed).toBe(true);
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.assigned_agent_id).toBeNull();
    // The conversation still gets handed off to the shared queue —
    // customer is never stranded over a bad config value.
    expect(conv?.status).toBe("pending");
    const run = mockDb.tables.flow_runs.find((r: Row) => r.flow_id === FLOW_ID);
    expect(run?.status).toBe("handed_off");
    const errorEvent = mockDb.tables.flow_run_events.find(
      (e: Row) => e.event_type === "error" && e.payload?.reason === "handoff_assign_to_invalid",
    );
    expect(errorEvent?.payload?.detail).toBe("user not found");
    // No internal detail (e.g. SQLSTATE) leaks into the logged payload.
    expect(JSON.stringify(errorEvent?.payload ?? {})).not.toMatch(/SQLSTATE|postgres/i);
  });

  it("cross-tenant: a real profile in a DIFFERENT account is never written to assigned_agent_id", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes("agent-b");
    mockDb.tables.profiles = [{ user_id: "agent-b", account_id: ACCOUNT_B, is_active: true }];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatch();

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.assigned_agent_id).toBeNull();
    expect(conv?.status).toBe("pending");
    const errorEvent = mockDb.tables.flow_run_events.find(
      (e: Row) => e.event_type === "error" && e.payload?.reason === "handoff_assign_to_invalid",
    );
    expect(errorEvent?.payload?.detail).toBe("user belongs to a different account");
  });

  it("inactive member: a deactivated profile in the SAME account is never written to assigned_agent_id", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes("agent-1");
    mockDb.tables.profiles = [{ user_id: "agent-1", account_id: ACCOUNT_A, is_active: false }];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatch();

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.assigned_agent_id).toBeNull();
    const errorEvent = mockDb.tables.flow_run_events.find(
      (e: Row) => e.event_type === "error" && e.payload?.reason === "handoff_assign_to_invalid",
    );
    expect(errorEvent?.payload?.detail).toBe("user is not active");
  });

  it("handoff without assign_to: unchanged — status flips to pending, assigned_agent_id column untouched by this write", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes(undefined);
    mockDb.tables.profiles = [];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: "previous-owner" }];

    await dispatch();

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    // No assign_to in config -> the update never includes the key ->
    // whatever was already there survives (same as before this guard).
    expect(conv?.assigned_agent_id).toBe("previous-owner");
    expect(conv?.status).toBe("pending");
    expect(mockDb.tables.flow_run_events.some((e: Row) => e.event_type === "error")).toBe(false);
  });

  it("never throws and never touches queue_id, across every invalid case", async () => {
    mockDb.tables.flows = [handoffFlow()];
    mockDb.tables.flow_nodes = handoffNodes("agent-b");
    mockDb.tables.profiles = [{ user_id: "agent-b", account_id: ACCOUNT_B, is_active: true }];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: "q-untouched", assigned_agent_id: null }];

    await expect(dispatch()).resolves.not.toThrow();
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-untouched");
  });
});
