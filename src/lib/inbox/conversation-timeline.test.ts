import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { ConversationEvent, ConversationEventType, Message } from "@/types";
import {
  buildConversationTimeline,
  CONVERSATION_HISTORY_MESSAGE_KEYS,
  describeConversationEvent,
  groupTimelineByDate,
} from "./conversation-timeline";
import {
  createConversationHistoryController,
  type HistoryFetcher,
  type HistoryFetchResult,
} from "@/hooks/use-conversation-history";

function msg(id: string, created_at: string): Message {
  return { id, conversation_id: "c1", sender_type: "customer", content_type: "text", status: "delivered", created_at } as Message;
}

function ev(id: string, event_type: ConversationEventType, created_at: string, extra: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    id,
    event_type,
    actor_user_id: null,
    actor_name: null,
    from_agent_id: null,
    from_agent_name: null,
    to_agent_id: null,
    to_agent_name: null,
    from_queue_id: null,
    from_queue_name: null,
    to_queue_id: null,
    to_queue_name: null,
    from_status: null,
    to_status: "pending",
    created_at,
    ...extra,
  };
}

const keyOf = (i: { kind: string; message?: Message; event?: ConversationEvent }) =>
  i.kind === "message" ? `m:${i.message!.id}` : `e:${i.event!.id}`;

describe("buildConversationTimeline — merge and ordering", () => {
  it("interleaves messages and events chronologically", () => {
    const items = buildConversationTimeline(
      [msg("m1", "2026-10-06T09:00:00.000Z"), msg("m2", "2026-10-06T09:15:00.000Z")],
      [ev("e1", "assigned", "2026-10-06T09:11:00.000Z"), ev("e2", "finalized", "2026-10-06T09:20:00.000Z")],
    );
    expect(items.map(keyOf)).toEqual(["m:m1", "e:e1", "m:m2", "e:e2"]);
  });

  it("uses the real chronology for opened/reopened — no shifting: a customer message stamped before the event stays before it", () => {
    const items = buildConversationTimeline(
      [msg("m1", "2026-10-06T14:03:00.000Z")],
      [ev("e1", "reopened", "2026-10-06T14:03:02.500Z", { from_status: "closed" })],
    );
    expect(items.map(keyOf)).toEqual(["m:m1", "e:e1"]);
    expect(items.map((i) => i.at)).toEqual(["2026-10-06T14:03:00.000Z", "2026-10-06T14:03:02.500Z"]);
  });

  it("exactly equal timestamp: the event comes before the message", () => {
    const at = "2026-10-06T10:00:00.000Z";
    const items = buildConversationTimeline([msg("a", at)], [ev("z", "closed", at, { from_status: "in_progress" })]);
    expect(items.map(keyOf)).toEqual(["e:z", "m:a"]);
  });

  it("same timestamp and same kind: id ascending (deterministic)", () => {
    const at = "2026-10-06T10:00:00.000Z";
    const items = buildConversationTimeline(
      [msg("m-b", at), msg("m-a", at)],
      [ev("e-b", "assigned", at), ev("e-a", "queue_changed", at)],
    );
    expect(items.map(keyOf)).toEqual(["e:e-a", "e:e-b", "m:m-a", "m:m-b"]);
  });

  it("never mutates the original arrays", () => {
    const messages = [msg("m2", "2026-10-06T10:00:00.000Z"), msg("m1", "2026-10-06T09:00:00.000Z")];
    const events = [ev("e2", "closed", "2026-10-06T11:00:00.000Z"), ev("e1", "assigned", "2026-10-06T08:00:00.000Z")];
    const messagesCopy = JSON.stringify(messages);
    const eventsCopy = JSON.stringify(events);
    buildConversationTimeline(messages, events);
    expect(JSON.stringify(messages)).toBe(messagesCopy);
    expect(JSON.stringify(events)).toBe(eventsCopy);
  });

  it("events never become messages: event items carry the event only, message items the message only", () => {
    const items = buildConversationTimeline([msg("m1", "2026-10-06T09:00:00.000Z")], [ev("e1", "opened", "2026-10-06T08:00:00.000Z")]);
    const eventItem = items.find((i) => i.kind === "event")!;
    expect(eventItem).not.toHaveProperty("message");
    expect(items.filter((i) => i.kind === "message")).toHaveLength(1);
  });

  it("each event knows the chronologically previous event (for closed → finalized wording)", () => {
    const items = buildConversationTimeline(
      [],
      [ev("e2", "finalized", "2026-10-06T10:05:00.000Z", { from_status: "closed" }), ev("e1", "closed", "2026-10-06T10:00:00.000Z", { from_status: "in_progress" })],
    );
    const fin = items.find((i) => i.kind === "event" && i.event.id === "e2");
    expect(fin && fin.kind === "event" ? fin.previousEvent?.id : null).toBe("e1");
  });
});

describe("groupTimelineByDate", () => {
  it("groups by local day and gives an events-only day its own group", () => {
    const d1 = new Date(2026, 9, 5, 10, 0).toISOString();
    const d2 = new Date(2026, 9, 6, 9, 0).toISOString();
    const d2b = new Date(2026, 9, 6, 9, 30).toISOString();
    const groups = groupTimelineByDate(
      buildConversationTimeline([msg("m1", d2b)], [ev("e0", "history_started", d1, { to_status: "in_progress" }), ev("e1", "assigned", d2)]),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map(keyOf)).toEqual(["e:e0"]);
    expect(groups[1].items.map(keyOf)).toEqual(["e:e1", "m:m1"]);
  });
});

describe("describeConversationEvent — wording from stored snapshots", () => {
  const A = { id: "u-a", name: "Cláudia" };
  const B = { id: "u-b", name: "Arthur" };
  const at = "2026-10-06T10:00:00.000Z";

  it("history_started: never 'started'; optional discreet snapshot details", () => {
    expect(describeConversationEvent(ev("e", "history_started", at))).toEqual({ key: "historyStarted", values: {}, details: [] });
    const d = describeConversationEvent(
      ev("e", "history_started", at, { to_agent_id: A.id, to_agent_name: A.name, to_queue_id: "q1", to_queue_name: "Comercial" }),
    );
    expect(d.key).toBe("historyStarted");
    expect(d.details).toEqual([
      { key: "historyStartedAgent", values: { agent: { kind: "name", value: "Cláudia" } } },
      { key: "historyStartedQueue", values: { queue: { kind: "name", value: "Comercial" } } },
    ]);
  });

  it("opened", () => {
    expect(describeConversationEvent(ev("e", "opened", at)).key).toBe("opened");
  });

  it("reopened: customer return without actor, 'reopened by' with actor", () => {
    expect(describeConversationEvent(ev("e", "reopened", at, { from_status: "closed" })).key).toBe("reopenedByCustomer");
    const d = describeConversationEvent(ev("e", "reopened", at, { from_status: "closed", actor_user_id: A.id, actor_name: A.name }));
    expect(d).toMatchObject({ key: "reopenedBy", values: { actor: { kind: "name", value: "Cláudia" } } });
  });

  it("assigned: self-claim, system, and by another actor", () => {
    expect(describeConversationEvent(ev("e", "assigned", at, { actor_user_id: A.id, actor_name: A.name, to_agent_id: A.id, to_agent_name: A.name })).key).toBe("assignedSelf");
    expect(describeConversationEvent(ev("e", "assigned", at, { to_agent_id: A.id, to_agent_name: A.name })).key).toBe("assignedSystem");
    const by = describeConversationEvent(ev("e", "assigned", at, { actor_user_id: B.id, actor_name: B.name, to_agent_id: A.id, to_agent_name: A.name }));
    expect(by).toMatchObject({ key: "assignedBy", values: { actor: { value: "Arthur" }, agent: { value: "Cláudia" } } });
  });

  it("reassigned: 'by actor' only when the actor is not one of the agents involved", () => {
    const base = { from_agent_id: A.id, from_agent_name: A.name, to_agent_id: B.id, to_agent_name: B.name };
    expect(describeConversationEvent(ev("e", "reassigned", at, base)).key).toBe("reassigned");
    expect(describeConversationEvent(ev("e", "reassigned", at, { ...base, actor_user_id: A.id, actor_name: A.name })).key).toBe("reassigned");
    expect(describeConversationEvent(ev("e", "reassigned", at, { ...base, actor_user_id: "u-admin", actor_name: "Admin" })).key).toBe("reassignedBy");
  });

  it("unassigned: with and without actor", () => {
    expect(describeConversationEvent(ev("e", "unassigned", at, { from_agent_id: A.id, from_agent_name: A.name })).key).toBe("unassigned");
    expect(describeConversationEvent(ev("e", "unassigned", at, { from_agent_id: A.id, from_agent_name: A.name, actor_user_id: B.id, actor_name: B.name })).key).toBe("unassignedBy");
  });

  it("queue_changed: from→to, only to, only from", () => {
    expect(describeConversationEvent(ev("e", "queue_changed", at, { from_queue_id: "q1", from_queue_name: "Comercial", to_queue_id: "q2", to_queue_name: "Financeiro" })).key).toBe("queueChanged");
    expect(describeConversationEvent(ev("e", "queue_changed", at, { to_queue_id: "q2", to_queue_name: "Financeiro" })).key).toBe("queueAssigned");
    expect(describeConversationEvent(ev("e", "queue_changed", at, { from_queue_id: "q1", from_queue_name: "Comercial" })).key).toBe("queueRemoved");
  });

  it("closed: never 'by …' without an actor", () => {
    expect(describeConversationEvent(ev("e", "closed", at, { from_status: "in_progress" })).key).toBe("closed");
    expect(describeConversationEvent(ev("e", "closed", at, { from_status: "in_progress", actor_user_id: A.id, actor_name: A.name })).key).toBe("closedBy");
  });

  it("finalized: normal vs. confirming the immediately preceding closed", () => {
    expect(describeConversationEvent(ev("e", "finalized", at, { from_status: "in_progress" })).key).toBe("finalized");
    expect(describeConversationEvent(ev("e", "finalized", at, { from_status: "in_progress", actor_user_id: A.id, actor_name: A.name })).key).toBe("finalizedBy");
    const closed = ev("c", "closed", at, { from_status: "in_progress" });
    expect(describeConversationEvent(ev("e", "finalized", at, { from_status: "closed" }), closed).key).toBe("finalizedConfirmed");
    expect(describeConversationEvent(ev("e", "finalized", at, { from_status: "closed", actor_user_id: A.id, actor_name: A.name }), closed).key).toBe("finalizedConfirmedBy");
    // from_status closed but the previous event is not that close (e.g. history_started) → plain finalized.
    expect(describeConversationEvent(ev("e", "finalized", at, { from_status: "closed" }), ev("h", "history_started", at, { to_status: "closed" })).key).toBe("finalized");
  });

  it("NULL name with an existing id → generic fallback; NULL id → the part is omitted; nothing invented", () => {
    const d = describeConversationEvent(ev("e", "assigned", at, { actor_user_id: B.id, actor_name: null, to_agent_id: A.id, to_agent_name: null }));
    expect(d).toMatchObject({ key: "assignedBy", values: { actor: { kind: "fallback", fallback: "agent" }, agent: { kind: "fallback", fallback: "agent" } } });
    const q = describeConversationEvent(ev("e", "queue_changed", at, { from_queue_id: "q1", from_queue_name: null, to_queue_id: "q2", to_queue_name: null }));
    expect(q.values).toEqual({ from: { kind: "fallback", fallback: "queue" }, to: { kind: "fallback", fallback: "queue" } });
    const sys = describeConversationEvent(ev("e", "closed", at, { from_status: "in_progress", actor_name: null }));
    expect(sys).toEqual({ key: "closed", values: {}, details: [] });
    const hs = describeConversationEvent(ev("e", "history_started", at, { to_agent_id: null, to_agent_name: "ignored" }));
    expect(hs.details).toEqual([]);
  });

  it("covers all 9 event types", () => {
    const types: ConversationEventType[] = ["history_started", "opened", "reopened", "assigned", "reassigned", "unassigned", "queue_changed", "closed", "finalized"];
    for (const type of types) {
      const d = describeConversationEvent(ev("e", type, at, { from_status: "closed", from_agent_id: A.id, to_agent_id: B.id, to_queue_id: "q" }));
      expect(CONVERSATION_HISTORY_MESSAGE_KEYS).toContain(d.key as (typeof CONVERSATION_HISTORY_MESSAGE_KEYS)[number]);
      expect(d.key).not.toBe("unknown");
    }
  });
});

describe("Inbox.history translations (pt-BR / en / ko)", () => {
  const load = (lang: string) =>
    JSON.parse(readFileSync(join(process.cwd(), "messages", `${lang}.json`), "utf8")).Inbox.history as Record<string, string>;
  const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();

  it("every key used by the wording exists in all 3 languages, with the same ICU placeholders", () => {
    const pt = load("pt-BR");
    for (const lang of ["pt-BR", "en", "ko"]) {
      const dict = load(lang);
      for (const key of CONVERSATION_HISTORY_MESSAGE_KEYS) {
        expect(typeof dict[key], `${lang}.${key}`).toBe("string");
        expect(placeholders(dict[key]), `${lang}.${key}`).toEqual(placeholders(pt[key]));
      }
    }
  });

  it("pt-BR texts match the approved wording", () => {
    const pt = load("pt-BR");
    expect(pt.historyStarted).toBe("Histórico de atendimento registrado a partir daqui");
    expect(pt.opened).toBe("Nova conversa iniciada");
    expect(pt.reopenedByCustomer).toBe("Cliente retornou · novo atendimento");
    expect(pt.finalizedConfirmed).toBe("Encerramento confirmado como finalizado");
    expect(pt.assignedSelf).toBe("{agent} assumiu o atendimento");
  });
});

describe("conversation history controller (core of useConversationHistory)", () => {
  function setup() {
    const pending: { id: string; resolve: (r: HistoryFetchResult) => void }[] = [];
    const fetchHistory = vi.fn<HistoryFetcher>(
      (id) => new Promise((resolve) => pending.push({ id, resolve })),
    );
    const states: { conversationId: string | null; events: ConversationEvent[] }[] = [];
    const ctl = createConversationHistoryController({ fetchHistory, onState: (s) => states.push(s) });
    return { ctl, fetchHistory, pending, states };
  }
  const e1 = ev("e1", "assigned", "2026-10-06T10:00:00.000Z");
  const e2 = ev("e2", "closed", "2026-10-06T11:00:00.000Z", { from_status: "in_progress" });
  const T0 = "2026-10-06T09:00:00.000Z";
  const T1 = "2026-10-06T09:00:01.000Z";
  const T2 = "2026-10-06T09:00:02.000Z";
  const T3 = "2026-10-06T09:00:03.000Z";

  /** Resolves the oldest pending fetch and waits for the sync that started it. */
  async function settle(
    p: Promise<void>,
    pending: { resolve: (r: HistoryFetchResult) => void }[],
    events: ConversationEvent[],
  ) {
    pending.shift()!.resolve({ ok: true, events });
    await p;
  }

  it("never fetches without a conversation id", async () => {
    const { ctl, fetchHistory } = setup();
    await ctl.sync({ conversationId: null, refreshKey: "k", updatedAt: T0, paused: false });
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("fetches on open, not again on a re-render, again on a refresh request (resync)", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|pending||", updatedAt: T0, paused: false }), pending, [e1]);
    await ctl.sync({ conversationId: "c1", refreshKey: "0|pending||", updatedAt: T0, paused: false });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "1|pending||", updatedAt: T0, paused: false }), pending, [e1]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("replaces the list on every response — no accumulation / duplication", async () => {
    const { ctl, pending, states } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T0, paused: false }), pending, [e1]);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "b", updatedAt: T0, paused: false }), pending, [e1, e2]);
    expect(states.at(-1)).toEqual({ conversationId: "c1", events: [e1, e2] });
  });

  it("switching conversation: the late response of the previous one is discarded", async () => {
    const { ctl, pending, states } = setup();
    const old = ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T0, paused: false });
    const cur = ctl.sync({ conversationId: "c2", refreshKey: "a", updatedAt: T0, paused: false });
    pending[1].resolve({ ok: true, events: [e2] });
    pending[0].resolve({ ok: true, events: [e1] });
    await Promise.all([old, cur]);
    expect(states).toEqual([{ conversationId: "c2", events: [e2] }]);
  });

  it("an older response of the same conversation never overwrites a newer one", async () => {
    const { ctl, pending, states } = setup();
    const first = ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T0, paused: false });
    const second = ctl.sync({ conversationId: "c1", refreshKey: "b", updatedAt: T0, paused: false });
    pending[1].resolve({ ok: true, events: [e1, e2] });
    pending[0].resolve({ ok: true, events: [e1] });
    await Promise.all([first, second]);
    expect(states).toEqual([{ conversationId: "c1", events: [e1, e2] }]);
  });

  it("404 (fetcher maps it to []) does not break: an empty list is published", async () => {
    const { ctl, pending, states } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T0, paused: false }), pending, []);
    expect(states).toEqual([{ conversationId: "c1", events: [] }]);
  });

  it("a failed fetch publishes nothing (messages unaffected) and the next server row retries", async () => {
    const { ctl, fetchHistory, pending, states } = setup();
    const p = ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T0, paused: false });
    pending.shift()!.resolve({ ok: false });
    await p;
    expect(states).toEqual([]);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "a", updatedAt: T1, paused: false }), pending, [e1]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  // ---- The defect found in the audit: the page's optimistic auto-claim ----
  // Real initial state: pending / assigned NULL. The page applies
  // in_progress + assigned = me TOGETHER with the selection, before its
  // write commits — so the thread's very first key is optimistic and the
  // first GET can run before the 'assigned' event exists.
  const OPTIMISTIC_CLAIM = "0|in_progress|me|";
  const PRE_CLAIM_SERVER = "0|pending||";

  it("AUTO-CLAIM: the first GET may miss the event; the claim's own realtime row (same key, new updated_at) refetches", async () => {
    const { ctl, fetchHistory, pending, states } = setup();
    // open with the optimistic claim → GET #1 runs before the commit (no event yet)
    await settle(ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T0, paused: false }), pending, []);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    // commit lands; realtime row: SAME status/assignee, new updated_at → must refetch
    await settle(ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T1, paused: false }), pending, [e1]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.events).toEqual([e1]); // the 'assigned' marker is now shown
    // later server rows that leave the key unchanged (messages, read state) fetch nothing
    await ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T2, paused: false });
    await ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T3, paused: false });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("AUTO-CLAIM: an unrelated server row (e.g. mark-read) landing BEFORE the claim commit still ends with the event fetched", async () => {
    const { ctl, fetchHistory, pending, states } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T0, paused: false }), pending, []);
    // mark-read row committed first: carries the PRE-claim server state
    await settle(ctl.sync({ conversationId: "c1", refreshKey: PRE_CLAIM_SERVER, updatedAt: T1, paused: false }), pending, []);
    // claim row committed: key differs from the last fetched one → refetch
    await settle(ctl.sync({ conversationId: "c1", refreshKey: OPTIMISTIC_CLAIM, updatedAt: T2, paused: false }), pending, [e1]);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(states.at(-1)?.events).toEqual([e1]);
  });

  it("FINALIZE OK (realtime after the response): no fetch while paused; exactly ONE fetch after the commit", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: false }), pending, [e1]);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T1, paused: false }), pending, [e1]); // confirms the open
    const base = fetchHistory.mock.calls.length;
    await ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T1, paused: true });
    await ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T1, paused: true }); // optimistic
    expect(fetchHistory.mock.calls.length).toBe(base);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T1, paused: false }), pending, [e1, e2]); // committed
    await ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T2, paused: false }); // realtime confirms same state
    expect(fetchHistory.mock.calls.length).toBe(base + 1);
  });

  it("FINALIZE OK (realtime arrives DURING the pause): still exactly ONE fetch after the commit", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: false }), pending, [e1]);
    const base = fetchHistory.mock.calls.length;
    await ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T0, paused: true });
    await ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T1, paused: true }); // realtime while paused
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T1, paused: false }), pending, [e1, e2]);
    expect(fetchHistory.mock.calls.length).toBe(base + 1);
  });

  it("FINALIZE FAILS + rollback: zero fetches, no phantom marker, nothing stuck", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: false }), pending, [e1]);
    const base = fetchHistory.mock.calls.length;
    await ctl.sync({ conversationId: "c1", refreshKey: "0|finalized|a1|", updatedAt: T0, paused: true });
    await ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: true }); // rollback
    await ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: false }); // pause lifts
    expect(fetchHistory.mock.calls.length).toBe(base);
    // not stuck: a later external change still refetches
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|closed|a1|", updatedAt: T1, paused: false }), pending, [e1, e2]);
    expect(fetchHistory.mock.calls.length).toBe(base + 1);
  });

  it("EXTERNAL change via realtime (status/assignee/queue + new updated_at) refetches", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|closed|a1|q1", updatedAt: T0, paused: false }), pending, [e1]);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|pending||", updatedAt: T1, paused: false }), pending, [e1, e2]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("message traffic causes no GETs once confirmed (updated_at changes, key unchanged)", async () => {
    const { ctl, fetchHistory, pending } = setup();
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T0, paused: false }), pending, [e1]);
    await settle(ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T1, paused: false }), pending, [e1]); // first server row confirms
    await ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T2, paused: false });
    await ctl.sync({ conversationId: "c1", refreshKey: "0|in_progress|a1|", updatedAt: T3, paused: false });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });
});
