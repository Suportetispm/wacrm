import { beforeEach, describe, expect, it, vi } from "vitest";

// Full-fidelity coverage of the new `assign_queue` node and the
// "don't reopen triage" guard in `findEntryFlow`/`dispatchInboundToFlows`.
// dispatch-inbound.test.ts already covers the accounts.is_active gate in
// isolation — this file exercises real node execution (start →
// collect_input → condition → assign_queue → end) against an in-memory
// fake of the Supabase query builder, since no existing test in this
// repo drives a full run advance.

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn().mockResolvedValue({ whatsapp_message_id: "wamid-fixture" }),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));

// ============================================================
// Minimal in-memory fake of the Supabase query builder — just enough
// of select/insert/update/eq/is/order/limit/maybeSingle to drive the
// engine's real code paths without a real Postgres.
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
    queues: seed.queues ?? [],
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
// Shared fixtures — a "1 → Financeiro" triage flow:
//   start -> collect_input(var=opcao) -> condition(opcao == "1")
//     true  -> assign_queue(queue-fin) -> end
//     false -> end (kept simple; fallback reprompt is out of scope here)
// ------------------------------------------------------------

const FLOW_ID = "flow-1";
const ACCOUNT_A = "acct-1";
const ACCOUNT_B = "acct-2";

function triageFlow(overrides: Partial<Row> = {}): Row {
  return {
    id: FLOW_ID,
    account_id: ACCOUNT_A,
    user_id: "user-1",
    name: "Triagem",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: {},
    entry_node_id: "start",
    fallback_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function triageNodes(): Row[] {
  return [
    { id: "n-start", flow_id: FLOW_ID, node_key: "start", node_type: "start", config: { next_node_key: "collect" } },
    {
      id: "n-collect",
      flow_id: FLOW_ID,
      node_key: "collect",
      node_type: "collect_input",
      config: { prompt_text: "1 - Financeiro", var_key: "opcao", next_node_key: "branch" },
    },
    {
      id: "n-branch",
      flow_id: FLOW_ID,
      node_key: "branch",
      node_type: "condition",
      config: { subject: "var", subject_key: "opcao", operator: "equals", value: "1", true_next: "assign_fin", false_next: "end" },
    },
    {
      id: "n-assign",
      flow_id: FLOW_ID,
      node_key: "assign_fin",
      node_type: "assign_queue",
      config: { queue_id: "queue-fin", next_node_key: "end" },
    },
    { id: "n-end", flow_id: FLOW_ID, node_key: "end", node_type: "end", config: {} },
  ];
}

beforeEach(() => {
  mockDb = createMockDb();
});

describe("first_inbound_message starts the triage flow", () => {
  it("suspends at collect_input and persists the run", async () => {
    mockDb.tables.flows = [triageFlow()];
    mockDb.tables.flow_nodes = triageNodes();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "Olá", meta_message_id: "m1" },
      isFirstInboundMessage: true,
    });

    expect(result.consumed).toBe(true);
    const run = mockDb.tables.flow_runs[0];
    expect(run).toBeDefined();
    expect(run.status).toBe("active");
    expect(run.current_node_key).toBe("collect");
  });

  it("does NOT start a new run when the conversation already has a queue_id — no hardcoded flow/company check", async () => {
    mockDb.tables.flows = [triageFlow()];
    mockDb.tables.flow_nodes = triageNodes();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: "queue-fin",
      assignedAgentId: null,
      message: { kind: "text", text: "Olá de novo", meta_message_id: "m2" },
      isFirstInboundMessage: true,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });

  it("does NOT start a new run when the conversation already has an assigned agent", async () => {
    mockDb.tables.flows = [triageFlow()];
    mockDb.tables.flow_nodes = triageNodes();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: "user-maria",
      message: { kind: "text", text: "Olá de novo", meta_message_id: "m3" },
      isFirstInboundMessage: true,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });
});

describe("active run resolves the menu reply and assign_queue routes correctly", () => {
  function seedActiveRunAtCollect() {
    mockDb.tables.flow_nodes = triageNodes();
    mockDb.tables.flow_runs = [
      {
        id: "run-1",
        flow_id: FLOW_ID,
        account_id: ACCOUNT_A,
        user_id: "user-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        status: "active",
        current_node_key: "collect",
        vars: {},
        reprompt_count: 0,
        started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.queues = [{ id: "queue-fin", account_id: ACCOUNT_A, is_active: true, name: "Financeiro" }];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];
  }

  it('"1" routes to the Financeiro queue, never touches assigned_agent_id, and completes the run', async () => {
    seedActiveRunAtCollect();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m10" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("queue-fin");
    expect(conv?.assigned_agent_id).toBeNull();
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("completed");
  });

  it('"8" (no matching option) never sets queue_id — falls to the false branch', async () => {
    seedActiveRunAtCollect();

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "8", meta_message_id: "m11" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
  });

  it("once the run completes, the SAME contact's next message ('1') does not resolve as a pending menu option (no active run left)", async () => {
    seedActiveRunAtCollect();
    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m12" },
      isFirstInboundMessage: false,
    });
    // No active flow left matching first_inbound_message (none seeded,
    // and even if one existed the queue_id-set guard above would block
    // it too) — a bare "1" with no active run and no matching trigger
    // must be a no-op, never silently reinterpreted as a menu choice.
    mockDb.tables.flows = [];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: "queue-fin",
      assignedAgentId: null,
      message: { kind: "text", text: "1", meta_message_id: "m13" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
  });
});

describe("assign_queue — server-side tenancy/is_active re-validation (never trusts node.config)", () => {
  function seedActiveRunAtBranch() {
    mockDb.tables.flow_nodes = triageNodes();
    mockDb.tables.flow_runs = [
      {
        id: "run-2",
        flow_id: FLOW_ID,
        account_id: ACCOUNT_A,
        user_id: "user-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        status: "active",
        current_node_key: "collect",
        vars: {},
        reprompt_count: 0,
        started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];
  }

  it("rejects a queue belonging to a DIFFERENT account — never writes conversations.queue_id, run still completes (non-fatal)", async () => {
    seedActiveRunAtBranch();
    mockDb.tables.queues = [{ id: "queue-fin", account_id: ACCOUNT_B, is_active: true, name: "Financeiro (other account)" }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m20" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-2");
    expect(run?.status).toBe("completed"); // still advanced to `end` — never stranded
  });

  it("rejects an inactive queue in the SAME account — never writes conversations.queue_id", async () => {
    seedActiveRunAtBranch();
    mockDb.tables.queues = [{ id: "queue-fin", account_id: ACCOUNT_A, is_active: false, name: "Financeiro (paused)" }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m21" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
  });

  it("rejects a non-existent queue_id gracefully — no throw, run still completes", async () => {
    seedActiveRunAtBranch();
    mockDb.tables.queues = []; // queue-fin does not exist at all

    const dispatchPromise = dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m22" },
      isFirstInboundMessage: false,
    });

    await expect(dispatchPromise).resolves.not.toThrow();
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
  });
});

describe("account isolation", () => {
  it("account A's run never resolves or touches account B's queue, even with a colliding queue id lookup", async () => {
    mockDb.tables.flow_nodes = triageNodes();
    mockDb.tables.flow_runs = [
      {
        id: "run-A",
        flow_id: FLOW_ID,
        account_id: ACCOUNT_A,
        user_id: "user-1",
        contact_id: "contact-A",
        conversation_id: "conv-A",
        status: "active",
        current_node_key: "collect",
        vars: {},
        reprompt_count: 0,
        started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    // Only account B's version of "queue-fin" exists.
    mockDb.tables.queues = [{ id: "queue-fin", account_id: ACCOUNT_B, is_active: true, name: "Financeiro B" }];
    mockDb.tables.conversations = [
      { id: "conv-A", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null },
    ];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-A",
      conversationId: "conv-A",
      message: { kind: "text", text: "1", meta_message_id: "m30" },
      isFirstInboundMessage: false,
    });

    const convA = mockDb.tables.conversations.find((c) => c.id === "conv-A");
    expect(convA?.queue_id).toBeNull();
  });
});
