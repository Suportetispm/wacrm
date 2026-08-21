import { beforeEach, describe, expect, it, vi } from "vitest";

// Full-fidelity coverage of the new `inbound_message` trigger_type
// ("Qualquer mensagem recebida" in the builder) — a broader triage
// entry point than `first_inbound_message`: fires on ANY inbound text
// on a conversation that hasn't been routed yet (queue_id AND
// assigned_agent_id both null), new contact or one with a full
// message history alike. Mirrors engine.queue-menu.test.ts's/
// engine.dup-flow-run.test.ts's in-memory Supabase fake (no real
// Postgres) — the existing pattern for driving dispatchInboundToFlows
// in this repo.

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
    let countMode = false;

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

    function resolve(): { data: unknown; error: { message: string } | null; count?: number } {
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
      const filtered = applyFilters(rows);
      if (countMode) return { data: filtered, error: null, count: filtered.length };
      return { data: filtered, error: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) countMode = true;
        return builder;
      },
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
      filter: (col: string, _op: string, val: unknown) => {
        filters.push((r) => {
          const path = col.match(/^payload->>(.+)$/)?.[1];
          if (!path) return true;
          return (r.payload ?? {})[path] === val;
        });
        return builder;
      },
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

const ACCOUNT_A = "acct-1";
const ACCOUNT_B = "acct-2";

function inboundMessageFlow(overrides: Partial<Row> = {}): Row {
  return {
    id: "flow-inbound",
    account_id: ACCOUNT_A,
    user_id: "user-1",
    name: "Triagem geral",
    status: "active",
    trigger_type: "inbound_message",
    trigger_config: {},
    entry_node_id: "start",
    fallback_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// INÍCIO → MENU DE SETORES → FIM — the main case (item 6/F).
function queueMenuNodes(flowId: string): Row[] {
  return [
    { id: `${flowId}-start`, flow_id: flowId, node_key: "start", node_type: "start", config: { next_node_key: "qm" } },
    {
      id: `${flowId}-qm`,
      flow_id: flowId,
      node_key: "qm",
      node_type: "queue_menu",
      config: {
        menu_text: "Olá! 1 Financeiro / 2 Suporte TI",
        options: [
          { value: "1", queue_id: "q-fin", label: "Financeiro" },
          { value: "2", queue_id: "q-ti", label: "Suporte TI" },
        ],
        invalid_text: "Opção inválida.",
        max_attempts: 3,
        next_node_key: "end",
      },
    },
    { id: `${flowId}-end`, flow_id: flowId, node_key: "end", node_type: "end", config: {} },
  ];
}

function baseQueues(accountId = ACCOUNT_A): Row[] {
  return [
    { id: "q-fin", account_id: accountId, is_active: true, name: "Financeiro" },
    { id: "q-ti", account_id: accountId, is_active: true, name: "Suporte TI" },
  ];
}

beforeEach(() => {
  mockDb = createMockDb();
  vi.mocked(engineSendText).mockClear();
});

describe("inbound_message — starts regardless of contact history", () => {
  it("a NEW contact's first-ever message starts the flow", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-new",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m1" },
      isFirstInboundMessage: true,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].current_node_key).toBe("qm");
  });

  it("an EXISTING contact with prior message history also starts the flow — isFirstInboundMessage=false does NOT block it", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-2", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-old",
      conversationId: "conv-2",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "Voltei", meta_message_id: "m2" },
      isFirstInboundMessage: false, // the exact condition first_inbound_message would reject
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
  });

  it("prior message history (multiple past messages) never impedes the trigger", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-3", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];
    // Simulates a conversation with a long history — nothing in the
    // dispatch input encodes "how many messages before this one", only
    // isFirstInboundMessage=false, which is exactly what a contact on
    // their 50th message would also report.
    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-veteran",
      conversationId: "conv-3",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "De novo aqui", meta_message_id: "m3" },
      isFirstInboundMessage: false,
    });
    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
  });
});

describe("inbound_message — routed-conversation guard", () => {
  it("does NOT start when conversation.queue_id is already set", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: "q-fin",
      assignedAgentId: null,
      message: { kind: "text", text: "Meu computador travou", meta_message_id: "m4" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });

  it("does NOT start when conversation.assigned_agent_id is already set", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: "user-maria",
      message: { kind: "text", text: "Oi de novo", meta_message_id: "m5" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });

  it("after routing, a NEW inbound message does not restart triage — queue_id/assigned_agent_id are never touched by this guard", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m6" }, isFirstInboundMessage: true,
    });
    // "2" picks Suporte TI, run completes.
    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "2", meta_message_id: "m7" }, isFirstInboundMessage: false,
    });
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-ti");
    expect(mockDb.tables.flow_runs).toHaveLength(1);

    // A brand new message arrives — webhook would now report the
    // conversation's REAL current queue_id/assigned_agent_id.
    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: conv?.queue_id ?? null, assignedAgentId: conv?.assigned_agent_id ?? null,
      message: { kind: "text", text: "Meu computador está com problema", meta_message_id: "m8" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(1); // still just the one run from before
    expect(conv?.queue_id).toBe("q-ti"); // untouched
  });
});

describe("inbound_message — active run has absolute priority over new triggers", () => {
  it("a reply to an active queue_menu run is delivered to that run, never starts a second one", async () => {
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.flows = [inboundMessageFlow()]; // present, but must NOT be (re-)evaluated
    mockDb.tables.flow_runs = [
      {
        id: "run-1", flow_id: "flow-inbound", account_id: ACCOUNT_A, user_id: "user-1",
        contact_id: "contact-1", conversation_id: "conv-1", status: "active",
        current_node_key: "qm", vars: { "__queue_menu:qm:attempts": 0 },
        reprompt_count: 0, started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "1", meta_message_id: "m9" }, isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1); // no second run created
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-fin"); // "1" resolved by the EXISTING run
  });

  it("a redelivered reply (same meta_message_id) to an active run is ignored — protection applies the same regardless of which trigger started the run", async () => {
    mockDb.tables.flow_nodes = [
      { id: "n-start", flow_id: "flow-inbound", node_key: "start", node_type: "start", config: { next_node_key: "c1" } },
      { id: "n-c1", flow_id: "flow-inbound", node_key: "c1", node_type: "collect_input", config: { prompt_text: "p1", var_key: "v1", next_node_key: "c2" } },
      { id: "n-c2", flow_id: "flow-inbound", node_key: "c2", node_type: "collect_input", config: { prompt_text: "p2", var_key: "v2", next_node_key: "end" } },
      { id: "n-end", flow_id: "flow-inbound", node_key: "end", node_type: "end", config: {} },
    ];
    mockDb.tables.flow_runs = [
      {
        id: "run-1", flow_id: "flow-inbound", account_id: ACCOUNT_A, user_id: "user-1",
        contact_id: "contact-1", conversation_id: "conv-1", status: "active",
        current_node_key: "c1", vars: {}, reprompt_count: 0, started_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const input = {
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text" as const, text: "resposta", meta_message_id: "dup-1" },
      isFirstInboundMessage: false,
    };
    const first = await dispatchInboundToFlows(input);
    expect(first.outcome).not.toBe("duplicate_inbound_ignored");

    vi.mocked(engineSendText).mockClear();
    const second = await dispatchInboundToFlows(input);
    expect(second.outcome).toBe("duplicate_inbound_ignored");
    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
  });
});

describe("inbound_message — full queue_menu integration (the main case)", () => {
  it('inbound_message starts the flow, queue_menu routes "2" to Suporte TI, run completes', async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m10" }, isFirstInboundMessage: true,
    });
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1); // menu sent once

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "2", meta_message_id: "m11" }, isFirstInboundMessage: false,
    });

    expect(result.outcome).toBe("completed");
    const conv = mockDb.tables.conversations.find((c) => c.id === "conv-1");
    expect(conv?.queue_id).toBe("q-ti");
    expect(conv?.assigned_agent_id).toBeNull();
  });
});

describe("inbound_message — first_inbound_message keeps working unchanged", () => {
  it("a first_inbound_message flow still starts on a genuine first message", async () => {
    mockDb.tables.flows = [
      {
        id: "flow-first",
        account_id: ACCOUNT_A,
        user_id: "user-1",
        name: "Boas-vindas (primeira mensagem)",
        status: "active",
        trigger_type: "first_inbound_message",
        trigger_config: {},
        entry_node_id: "start",
        fallback_policy: {},
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.flow_nodes = [
      { id: "n-start", flow_id: "flow-first", node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { id: "n-end", flow_id: "flow-first", node_key: "end", node_type: "end", config: {} },
    ];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m12" }, isFirstInboundMessage: true,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].flow_id).toBe("flow-first");
  });

  it("a first_inbound_message flow does NOT start for a returning contact (isFirstInboundMessage=false) — unchanged behavior", async () => {
    mockDb.tables.flows = [
      {
        id: "flow-first", account_id: ACCOUNT_A, user_id: "user-1", name: "Boas-vindas",
        status: "active", trigger_type: "first_inbound_message", trigger_config: {},
        entry_node_id: "start", fallback_policy: {}, created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockDb.tables.flow_nodes = [
      { id: "n-start", flow_id: "flow-first", node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { id: "n-end", flow_id: "flow-first", node_key: "end", node_type: "end", config: {} },
    ];
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi de novo", meta_message_id: "m13" }, isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });
});

describe("inbound_message — multiple eligible flows: documented current behavior, no new priority system", () => {
  it("with BOTH a first_inbound_message and an inbound_message flow eligible, the OLDER (earlier created_at) one wins — plain array order, not type-based priority", async () => {
    mockDb.tables.flows = [
      inboundMessageFlow({ id: "flow-inbound", created_at: "2026-01-01T00:00:00.000Z" }),
      {
        id: "flow-first", account_id: ACCOUNT_A, user_id: "user-1", name: "Boas-vindas",
        status: "active", trigger_type: "first_inbound_message", trigger_config: {},
        entry_node_id: "start", fallback_policy: {}, created_at: "2026-02-01T00:00:00.000Z", // newer
      },
    ];
    mockDb.tables.flow_nodes = [
      ...queueMenuNodes("flow-inbound"),
      { id: "n2-start", flow_id: "flow-first", node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { id: "n2-end", flow_id: "flow-first", node_key: "end", node_type: "end", config: {} },
    ];
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m14" }, isFirstInboundMessage: true, // matches BOTH
    });

    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].flow_id).toBe("flow-inbound"); // the OLDER flow, per created_at ASC
  });

  it("swap the created_at order: the flow created first still wins, regardless of trigger_type", async () => {
    mockDb.tables.flows = [
      {
        id: "flow-first", account_id: ACCOUNT_A, user_id: "user-1", name: "Boas-vindas",
        status: "active", trigger_type: "first_inbound_message", trigger_config: {},
        entry_node_id: "start", fallback_policy: {}, created_at: "2026-01-01T00:00:00.000Z", // now older
      },
      inboundMessageFlow({ id: "flow-inbound", created_at: "2026-02-01T00:00:00.000Z" }), // now newer
    ];
    mockDb.tables.flow_nodes = [
      { id: "n2-start", flow_id: "flow-first", node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { id: "n2-end", flow_id: "flow-first", node_key: "end", node_type: "end", config: {} },
      ...queueMenuNodes("flow-inbound"),
    ];
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m15" }, isFirstInboundMessage: true,
    });

    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].flow_id).toBe("flow-first"); // now the older one, by created_at
  });
});

describe("inbound_message — account isolation", () => {
  it("account A never runs account B's inbound_message flow", async () => {
    mockDb.tables.flows = [inboundMessageFlow({ id: "flow-b", account_id: ACCOUNT_B })];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-b");
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m16" }, isFirstInboundMessage: true,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });
});

describe("inbound_message — at most one active run per contact under concurrency", () => {
  it("two near-simultaneous first-time deliveries for the same contact start exactly ONE run", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const callA = dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "race-a" }, isFirstInboundMessage: true,
    });
    const callB = dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Bom dia", meta_message_id: "race-b" }, isFirstInboundMessage: true,
    });

    const [resultA, resultB] = await Promise.all([callA, callB]);
    const startedOutcomes = [resultA.outcome, resultB.outcome].filter(
      (o) => o === "started" || o === "advanced",
    );
    expect(startedOutcomes.length).toBeLessThanOrEqual(1);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(
      mockDb.tables.flow_runs.filter((r) => r.status === "active"),
    ).toHaveLength(1);
  });
});
