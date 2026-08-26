import { beforeEach, describe, expect, it, vi } from "vitest";

// Media (image/document) as a trigger for `inbound_message` — "nova
// entrada de atendimento" for a closed/finalized conversation that just
// had its queue_id/assigned_agent_id cleared by migration 063, without
// requiring the customer to follow up with actual text. Mirrors
// engine.inbound-message-trigger.test.ts's in-memory Supabase fake (no
// real Postgres) — the existing pattern for driving
// dispatchInboundToFlows in this repo. See ParsedInbound's `kind:
// "media"` variant in types.ts and the active-run guard + findEntryFlow
// kind-gating in engine.ts.

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

function keywordFlow(overrides: Partial<Row> = {}): Row {
  return {
    id: "flow-keyword",
    account_id: ACCOUNT_A,
    user_id: "user-1",
    name: "Palavra-chave",
    status: "active",
    trigger_type: "keyword",
    trigger_config: { keywords: ["oi"], match_type: "contains" },
    entry_node_id: "start",
    fallback_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function firstInboundFlow(overrides: Partial<Row> = {}): Row {
  return {
    id: "flow-first",
    account_id: ACCOUNT_A,
    user_id: "user-1",
    name: "Primeira mensagem",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: {},
    entry_node_id: "start",
    fallback_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// INÍCIO → MENU DE SETORES → FIM — same shape as engine.inbound-message-trigger.test.ts.
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

function mediaMessage(overrides: Partial<Row> = {}) {
  return {
    kind: "media" as const,
    media_type: "image" as const,
    meta_message_id: "media-1",
    ...overrides,
  };
}

beforeEach(() => {
  mockDb = createMockDb();
  vi.mocked(engineSendText).mockClear();
});

describe("media — starts inbound_message on an unrouted conversation (no active run)", () => {
  it("image with no active run and routing null/null starts the flow", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: mediaMessage({ media_type: "image" }),
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].current_node_key).toBe("qm");
  });

  it("document with no active run and routing null/null starts the flow", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-2", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-2",
      conversationId: "conv-2",
      queueId: null,
      assignedAgentId: null,
      message: mediaMessage({ media_type: "document", meta_message_id: "media-2" }),
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
  });
});

describe("media — never advances or perturbs an active run", () => {
  it("media arriving while a run is suspended on a queue_menu does NOT advance it, does NOT bump reprompt_count, and does NOT fire fallback_fired", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    // Start the run for real via a text message, same as any other test —
    // it ends up suspended on the queue_menu node awaiting "1"/"2".
    await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      queueId: null, assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "m1" }, isFirstInboundMessage: true,
    });
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    const run = mockDb.tables.flow_runs[0];
    expect(run.status).toBe("active");
    expect(run.current_node_key).toBe("qm");
    const repromptBefore = run.reprompt_count;
    const eventsBefore = mockDb.tables.flow_run_events.length;

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: mediaMessage(),
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    // Run is left EXACTLY as it was — never touched.
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].status).toBe("active");
    expect(mockDb.tables.flow_runs[0].current_node_key).toBe("qm");
    expect(mockDb.tables.flow_runs[0].reprompt_count).toBe(repromptBefore);
    // No new flow_run_events at all — not even a "reply_received" log —
    // handleReplyForActiveRun is never called for media.
    expect(mockDb.tables.flow_run_events.length).toBe(eventsBefore);
    expect(
      mockDb.tables.flow_run_events.some((e) => e.event_type === "fallback_fired"),
    ).toBe(false);

    // A real reply right after still works normally — the run wasn't
    // corrupted by the media in between.
    const followUp = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "2", meta_message_id: "m2" }, isFirstInboundMessage: false,
    });
    expect(followUp.outcome).toBe("completed");
  });
});

describe("media — never satisfies keyword or first_inbound_message", () => {
  it("does not match a keyword flow even when a co-existing inbound_message flow would otherwise be shadowed by it", async () => {
    // keyword flow created first (would normally win via created_at ASC
    // ordering) — proves media skips right past it instead of merely
    // losing a priority race.
    mockDb.tables.flows = [
      keywordFlow({ created_at: "2025-01-01T00:00:00.000Z" }),
      inboundMessageFlow({ created_at: "2026-01-01T00:00:00.000Z" }),
    ];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: mediaMessage(),
      isFirstInboundMessage: false,
    });

    // inbound_message still starts (media is eligible for it) — but the
    // keyword flow never does, proving the exclusion is real and not an
    // artifact of ordering.
    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].flow_id).toBe("flow-inbound");
  });

  it("does not match first_inbound_message even when isFirstInboundMessage is true", async () => {
    mockDb.tables.flows = [firstInboundFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-first");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-new",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: mediaMessage(),
      isFirstInboundMessage: true,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });

  it("with BOTH first_inbound_message and inbound_message eligible, media only ever starts the inbound_message one", async () => {
    mockDb.tables.flows = [firstInboundFlow(), inboundMessageFlow()];
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
      message: mediaMessage(),
      isFirstInboundMessage: true,
    });

    expect(result.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(mockDb.tables.flow_runs[0].flow_id).toBe("flow-inbound");
  });
});

describe("media — routed-conversation guard applies identically to media", () => {
  it("does NOT start when conversation.queue_id is already set (e.g. pending, already triaged)", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: "q-fin",
      assignedAgentId: null,
      message: mediaMessage(),
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });

  it("does NOT start when conversation.assigned_agent_id is already set (e.g. in_progress/waiting_customer with an agent)", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: "user-maria",
      message: mediaMessage(),
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(mockDb.tables.flow_runs).toHaveLength(0);
  });
});

describe("media — no duplicate run when text follows shortly after", () => {
  it("image starts the run; a text message right after finds the SAME active run instead of starting a second one", async () => {
    mockDb.tables.flows = [inboundMessageFlow()];
    mockDb.tables.flow_nodes = queueMenuNodes("flow-inbound");
    mockDb.tables.queues = baseQueues();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const first = await dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: mediaMessage(),
      isFirstInboundMessage: false,
    });
    expect(first.consumed).toBe(true);
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    const runId = mockDb.tables.flow_runs[0].id;

    const second = await dispatchInboundToFlows({
      accountId: ACCOUNT_A, userId: "user-1", contactId: "contact-1", conversationId: "conv-1",
      message: { kind: "text", text: "2", meta_message_id: "m-follow-up" }, isFirstInboundMessage: false,
    });

    expect(second.flow_run_id).toBe(runId);
    expect(mockDb.tables.flow_runs).toHaveLength(1); // still just one run
    expect(second.outcome).toBe("completed"); // "2" picked Suporte TI on the SAME run
  });
});
