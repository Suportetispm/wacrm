import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Regression coverage from the 2026-08-21 "menu + collect_input sent
// twice" investigation, reported on a real UAZAPI test.
//
// This file does NOT change flow/RLS/assign_queue/menu logic. It
// only exercises the EXISTING concurrency protections documented at
// the top of engine.ts (partial unique index
// `idx_one_active_run_per_contact` + optimistic current_node_key
// update) against the exact scenario the audit needed evidence for:
// two inbound deliveries for the same contact racing to start the
// same first_inbound_message-triggered flow.
//
// Reuses the same in-memory Supabase-query-builder fake as
// engine.assign-queue.test.ts (23505 clash simulated on a second
// concurrent INSERT into flow_runs with status='active' for the same
// (account_id, contact_id)).
// ============================================================

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
        // Only used here for payload->>meta_message_id equality checks.
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

const FLOW_ID = "flow-1";
const ACCOUNT_A = "acct-1";

// Mirrors the reported real-world shape: send_message (menu) auto-advances
// into collect_input (the question) — exactly the "pair" from the bug report.
function menuThenCollectFlow(): Row {
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

function menuThenCollectNodes(): Row[] {
  return [
    { id: "n-start", flow_id: FLOW_ID, node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
    {
      id: "n-menu",
      flow_id: FLOW_ID,
      node_key: "menu",
      node_type: "send_message",
      config: { text: "Olá! 1 Financeiro / 2 Suporte TI", next_node_key: "collect" },
    },
    {
      id: "n-collect",
      flow_id: FLOW_ID,
      node_key: "collect",
      node_type: "collect_input",
      config: { prompt_text: "Por favor, digite somente o número.", var_key: "opcao", next_node_key: "end" },
    },
    { id: "n-end", flow_id: FLOW_ID, node_key: "end", node_type: "end", config: {} },
  ];
}

beforeEach(() => {
  mockDb = createMockDb();
  vi.mocked(engineSendText).mockClear();
});

describe("dup-flow-run — two concurrent first-inbound deliveries for the same contact", () => {
  it("starts exactly ONE run and sends the menu+collect_input pair exactly ONCE, never twice", async () => {
    mockDb.tables.flows = [menuThenCollectFlow()];
    mockDb.tables.flow_nodes = menuThenCollectNodes();
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    // Two genuinely different inbound messages (different meta_message_id,
    // as two real customer texts sent moments apart would be) racing to
    // dispatch concurrently, BOTH computed as isFirstInboundMessage=true —
    // the known race in persistInboundTextMessage's prior-count check.
    const callA = dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "Oi", meta_message_id: "race-a" },
      isFirstInboundMessage: true,
    });
    const callB = dispatchInboundToFlows({
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      queueId: null,
      assignedAgentId: null,
      message: { kind: "text", text: "Bom dia", meta_message_id: "race-b" },
      isFirstInboundMessage: true,
    });

    const [resultA, resultB] = await Promise.all([callA, callB]);

    // At most one of the two calls actually started a run — the other
    // must be a no-op collision (duplicate_inbound_ignored) or no_match.
    const startedOutcomes = [resultA.outcome, resultB.outcome].filter(
      (o) => o === "started" || o === "advanced",
    );
    expect(startedOutcomes.length).toBeLessThanOrEqual(1);

    // Exactly one active flow_runs row for this contact — never two.
    const activeRuns = mockDb.tables.flow_runs.filter(
      (r) => r.account_id === ACCOUNT_A && r.contact_id === "contact-1" && r.status === "active",
    );
    expect(mockDb.tables.flow_runs).toHaveLength(1);
    expect(activeRuns).toHaveLength(1);

    // The pair (menu + collect_input prompt) was sent exactly once —
    // this is the exact bug reported: it must NOT be twice.
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(2);
  });
});

describe("dup-flow-run — same event delivered twice to an already-active run", () => {
  it("a redelivered reply (same meta_message_id) is ignored — never re-advances or re-sends", async () => {
    // collect_input -> collect_input (2nd) -> end: the reply below advances
    // to a node that ALSO suspends, so the run stays 'active' after the
    // first delivery — the only way to actually exercise isDuplicateInbound
    // (a run that completes outright on the first reply, as in
    // menuThenCollectNodes(), goes inactive and blocks re-entry via the
    // isFirstInboundMessage=false guard instead — a real but different
    // protection layer than the one under test here).
    mockDb.tables.flow_nodes = [
      ...menuThenCollectNodes().filter((n) => n.node_key !== "collect"),
      {
        id: "n-collect",
        flow_id: FLOW_ID,
        node_key: "collect",
        node_type: "collect_input",
        config: { prompt_text: "Por favor, digite somente o número.", var_key: "opcao", next_node_key: "collect2" },
      },
      {
        id: "n-collect2",
        flow_id: FLOW_ID,
        node_key: "collect2",
        node_type: "collect_input",
        config: { prompt_text: "Confirma?", var_key: "confirma", next_node_key: "end" },
      },
    ];
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
    mockDb.tables.conversations = [{ id: "conv-1", account_id: ACCOUNT_A, queue_id: null, assigned_agent_id: null }];

    const input = {
      accountId: ACCOUNT_A,
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text" as const, text: "1", meta_message_id: "reply-1" },
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
