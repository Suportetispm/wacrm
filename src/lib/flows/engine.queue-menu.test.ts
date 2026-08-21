import { beforeEach, describe, expect, it, vi } from "vitest";

// Full-fidelity coverage of the new `queue_menu` node ("Menu de
// setores" in the builder) — the high-level triage-by-menu shortcut
// that bundles collect_input + N conditions + assign_queue into one
// node. Mirrors engine.assign-queue.test.ts's in-memory Supabase fake
// (no real Postgres) since that's the existing pattern for driving a
// full run advance in this repo.

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn().mockResolvedValue({ whatsapp_message_id: "wamid-fixture" }),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));

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
    rpc: async () => ({ data: null, error: null }),
  };
}

let mockDb: ReturnType<typeof createMockDb>;

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => mockDb,
}));

import { dispatchInboundToFlows } from "./engine";
import { engineSendText } from "./meta-send";

const FLOW_ID = "flow-1";
const ACCOUNT_A = "acct-1";
const ACCOUNT_B = "acct-2";

function queueMenuFlow(): Row {
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
  };
}

function queueMenuNodes(overrides: Partial<Row> = {}): Row[] {
  return [
    { id: "n-start", flow_id: FLOW_ID, node_key: "start", node_type: "start", config: { next_node_key: "qm" } },
    {
      id: "n-qm",
      flow_id: FLOW_ID,
      node_key: "qm",
      node_type: "queue_menu",
      config: {
        menu_text: "Olá! 1 Financeiro / 2 Suporte TI",
        options: [
          { value: "1", queue_id: "q-fin", label: "Financeiro" },
          { value: "2", queue_id: "q-ti", label: "Suporte TI" },
        ],
        invalid_text: "Opção inválida. Digite uma das opções disponíveis.",
        max_attempts: 3,
        fallback_queue_id: "q-fallback",
        fallback_queue_label: "Atendimento Geral",
        next_node_key: "end",
        ...overrides,
      },
    },
    { id: "n-end", flow_id: FLOW_ID, node_key: "end", node_type: "end", config: {} },
  ];
}

function baseQueues(): Row[] {
  return [
    { id: "q-fin", account_id: ACCOUNT_A, is_active: true, name: "Financeiro" },
    { id: "q-ti", account_id: ACCOUNT_A, is_active: true, name: "Suporte TI" },
    { id: "q-fallback", account_id: ACCOUNT_A, is_active: true, name: "Atendimento Geral" },
  ];
}

function seedActiveRunAtMenu(nodesOverride?: Row[]) {
  mockDb.tables.flow_nodes = nodesOverride ?? queueMenuNodes();
  mockDb.tables.flow_runs = [
    {
      id: "run-1",
      flow_id: FLOW_ID,
      account_id: ACCOUNT_A,
      user_id: "user-1",
      contact_id: "contact-1",
      conversation_id: "conv-1",
      status: "active",
      current_node_key: "qm",
      vars: { "__queue_menu:qm:attempts": 0 },
      reprompt_count: 0,
      started_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  mockDb.tables.queues = baseQueues();
  mockDb.tables.conversations = [
    { id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null, status: "open" },
  ];
}

beforeEach(() => {
  mockDb = createMockDb();
  vi.mocked(engineSendText).mockClear();
});

describe("queue_menu — entry", () => {
  it("sends the menu exactly once and suspends, waiting for a reply", async () => {
    mockDb.tables.flows = [queueMenuFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes();
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
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    const run = mockDb.tables.flow_runs[0];
    expect(run.status).toBe("active");
    expect(run.current_node_key).toBe("qm");
  });
});

describe("queue_menu — valid reply", () => {
  it('"1" routes to Financeiro, never re-sends the menu, completes the run', async () => {
    seedActiveRunAtMenu();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m10" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled(); // no message sent by queue_menu itself on a match
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-fin");
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("completed");
  });

  it('"2" routes to Suporte TI', async () => {
    seedActiveRunAtMenu();

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "2", meta_message_id: "m11" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-ti");
  });

  it("trims whitespace around the reply before matching", async () => {
    seedActiveRunAtMenu();

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "  1  ", meta_message_id: "m12" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-fin");
  });

  it("never touches assigned_agent_id, whatever it was before", async () => {
    seedActiveRunAtMenu();
    mockDb.tables.conversations[0].assigned_agent_id = "user-maria";

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m13" },
      isFirstInboundMessage: false,
    });

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.assigned_agent_id).toBe("user-maria");
  });

  it("a reply after the run has already resolved is not re-interpreted as a menu choice", async () => {
    seedActiveRunAtMenu();
    await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m14" },
      isFirstInboundMessage: false,
    });
    mockDb.tables.flows = []; // no first_inbound flow left to (re-)match either

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: "q-fin",
      assignedAgentId: null,
      message: { kind: "text", text: "1", meta_message_id: "m15" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
  });
});

describe("queue_menu — invalid reply", () => {
  it("sends ONLY the invalid message — never re-sends the menu — and stays suspended", async () => {
    seedActiveRunAtMenu();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "9", meta_message_id: "m20" },
      isFirstInboundMessage: false,
    });

    expect(result.outcome).toBe("fallback_fired");
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText)).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Opção inválida. Digite uma das opções disponíveis." }),
    );
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("active");
    expect(run?.current_node_key).toBe("qm");
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
  });

  it("increments the attempt counter in flow_runs.vars across invalid replies", async () => {
    seedActiveRunAtMenu();

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "x", meta_message_id: "m21" }, isFirstInboundMessage: false,
    });
    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "y", meta_message_id: "m22" }, isFirstInboundMessage: false,
    });

    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.vars["__queue_menu:qm:attempts"]).toBe(2);
    expect(run?.status).toBe("active"); // max_attempts=3, still under the limit
  });
});

describe("queue_menu — attempts exhausted", () => {
  it("routes to fallback_queue_id once max_attempts is hit, and advances", async () => {
    seedActiveRunAtMenu();

    for (const id of ["m30", "m31", "m32"]) {
      await dispatchInboundToFlows({
        accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
        message: { kind: "text", text: "nope", meta_message_id: id }, isFirstInboundMessage: false,
      });
    }

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-fallback");
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("completed");
  });

  it("with NO fallback_queue_id configured: ends the flow WITHOUT touching queue_id, assigned_agent_id, or conversation status", async () => {
    seedActiveRunAtMenu(
      queueMenuNodes({ fallback_queue_id: undefined, fallback_queue_label: undefined }),
    );

    for (const id of ["m40", "m41", "m42"]) {
      await dispatchInboundToFlows({
        accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
        message: { kind: "text", text: "nope", meta_message_id: id }, isFirstInboundMessage: false,
      });
    }

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
    expect(conv?.assigned_agent_id).toBeNull();
    expect(conv?.status).toBe("open"); // untouched — never flipped to pending
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("completed");
    expect(run?.end_reason).toBe("queue_menu_exhausted_no_fallback");
  });
});

describe("queue_menu — runtime queue re-validation (config errors, not user errors)", () => {
  it("an option's queue from a DIFFERENT account: no invalid-option message sent, queue_id untouched, run fails", async () => {
    seedActiveRunAtMenu();
    mockDb.tables.queues = [
      { id: "q-fin", account_id: ACCOUNT_B, is_active: true, name: "Financeiro (other account)" },
      ...baseQueues().filter((q) => q.id !== "q-fin"),
    ];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m50" }, isFirstInboundMessage: false,
    });

    // Never told the customer their digit was wrong for what's actually
    // a configuration problem.
    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("failed");
  });

  it("an option's queue that's inactive: same config-error treatment", async () => {
    seedActiveRunAtMenu();
    mockDb.tables.queues = [
      { id: "q-fin", account_id: ACCOUNT_A, is_active: false, name: "Financeiro (paused)" },
      ...baseQueues().filter((q) => q.id !== "q-fin"),
    ];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m51" }, isFirstInboundMessage: false,
    });

    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
  });

  it("an invalid fallback_queue_id (exhausted attempts): never guesses another queue, run fails", async () => {
    mockDb.tables.flow_nodes = queueMenuNodes();
    mockDb.tables.flow_runs = [
      {
        id: "run-1", flow_id: FLOW_ID, account_id: ACCOUNT_A, user_id: "user-1",
        contact_id: "contact-1", conversation_id: "conv-1", status: "active",
        current_node_key: "qm", vars: { "__queue_menu:qm:attempts": 0 },
        reprompt_count: 0, started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.queues = [
      { id: "q-fin", account_id: ACCOUNT_A, is_active: true, name: "Financeiro" },
      { id: "q-ti", account_id: ACCOUNT_A, is_active: true, name: "Suporte TI" },
      // q-fallback intentionally absent — simulates a deleted/foreign queue.
    ];
    mockDb.tables.conversations = [
      { id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null, status: "open" },
    ];

    for (const id of ["m60", "m61", "m62"]) {
      await dispatchInboundToFlows({
        accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
        message: { kind: "text", text: "nope", meta_message_id: id }, isFirstInboundMessage: false,
      });
    }

    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBeNull();
    const run = mockDb.tables.flow_runs.find((r) => r.id === "run-1");
    expect(run?.status).toBe("failed");
  });
});
