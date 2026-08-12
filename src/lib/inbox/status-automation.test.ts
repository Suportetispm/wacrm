import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  openPendingConversation,
  sweepStaleConversations,
} from "./status-automation";
import type { Conversation } from "@/types";

// ------------------------------------------------------------
// Minimal Supabase client stub. Query-builder methods (eq/is/select/
// order/limit) return `this` so any chain shape resolves; the chain is
// itself thenable (mirrors the real supabase-js builder, which is
// awaitable directly without a terminal call) so both call styles used
// in status-automation.ts work:
//   await supabase.from(t).update(p).eq(...).eq(...)             (sweep)
//   await supabase.from(t).update(p).eq(...).eq(...).select().maybeSingle()  (open)
//
// The stub is deliberately NOT typed as SupabaseClient — it only
// implements the handful of methods status-automation.ts actually
// calls. `open`/`sweep` below cast it at the one point it's handed to
// the functions under test, so every test can call `supabase.from`/
// `.rpc` directly (they're plain vi.fn mocks) without an `any` escape
// hatch anywhere in the test bodies themselves.
// ------------------------------------------------------------

type Result = { data: unknown; error: unknown };

function chain(result: Result) {
  const builder: Record<string, unknown> = {
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    select: () => builder,
    maybeSingle: async () => result,
    then: (resolve: (r: Result) => void) => resolve(result),
  };
  return builder;
}

function makeSupabase(opts: {
  ticketed: string[] | { error: unknown };
  /** Successive results for each `.update()` call on `conversations`, in call order. */
  updateResults?: Result[];
  /** Result for the `.select()` candidates query in the sweep. */
  selectResult?: Result;
  onUpdate?: (patch: Record<string, unknown>) => void;
}) {
  let updateCallIndex = 0;
  const rpc = vi.fn(async () => {
    if (Array.isArray(opts.ticketed)) return { data: opts.ticketed, error: null };
    return { data: null, error: opts.ticketed.error };
  });
  const from = vi.fn((table: string) => {
    if (table !== "conversations") throw new Error(`unexpected table: ${table}`);
    return {
      select: () => chain(opts.selectResult ?? { data: [], error: null }),
      update: (patch: Record<string, unknown>) => {
        opts.onUpdate?.(patch);
        const result = opts.updateResults?.[updateCallIndex] ?? {
          data: null,
          error: null,
        };
        updateCallIndex += 1;
        return chain(result);
      },
    };
  });
  return { rpc, from };
}

type SupabaseStub = ReturnType<typeof makeSupabase>;

function open(
  supabase: SupabaseStub,
  conversation: Pick<Conversation, "id" | "status">,
  callerId: string,
) {
  return openPendingConversation(
    supabase as unknown as SupabaseClient,
    conversation,
    callerId,
  );
}

function sweep(supabase: SupabaseStub) {
  return sweepStaleConversations(supabase as unknown as SupabaseClient);
}

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "pending",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("openPendingConversation", () => {
  it("is not_applicable (no DB write attempted) when the conversation isn't pending", async () => {
    const supabase = makeSupabase({ ticketed: [] });
    const result = await open(supabase, conv({ status: "in_progress" }), "agent-1");
    expect(result.outcome).toBe("not_applicable");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("is not_applicable (no DB write attempted) when the conversation already has a ticket", async () => {
    const supabase = makeSupabase({ ticketed: ["c1"] });
    const result = await open(supabase, conv(), "agent-1");
    expect(result.outcome).toBe("not_applicable");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("claims an unassigned pending conversation for the caller", async () => {
    const claimed = { id: "c1", status: "in_progress", assigned_agent_id: "agent-1" };
    const supabase = makeSupabase({
      ticketed: [],
      updateResults: [{ data: claimed, error: null }],
    });
    const result = await open(supabase, conv(), "agent-1");
    expect(result).toEqual({ outcome: "claimed", conversation: claimed });
  });

  it("resumes (status only) when already assigned to the caller — never touches assignee", async () => {
    const resumed = { id: "c1", status: "in_progress", assigned_agent_id: "agent-1" };
    const updatePatches: Record<string, unknown>[] = [];
    const supabase = makeSupabase({
      ticketed: [],
      // 1st update (claim, guarded by assigned_agent_id IS NULL) matches nothing.
      // 2nd update (resume, guarded by assigned_agent_id = caller) matches.
      updateResults: [{ data: null, error: null }, { data: resumed, error: null }],
      onUpdate: (patch) => updatePatches.push(patch),
    });
    const result = await open(supabase, conv({ assigned_agent_id: "agent-1" }), "agent-1");
    expect(result).toEqual({ outcome: "resumed", conversation: resumed });
    // The resume patch must never include assigned_agent_id.
    expect(updatePatches[1]).not.toHaveProperty("assigned_agent_id");
  });

  it("does not steal a conversation assigned to a different agent — status and assignee both untouched", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      // Both guarded attempts match 0 rows: not unassigned, not the caller's.
      updateResults: [{ data: null, error: null }, { data: null, error: null }],
    });
    const result = await open(supabase, conv({ assigned_agent_id: "agent-OTHER" }), "agent-1");
    expect(result).toEqual({ outcome: "not_applicable" });
  });

  it("surfaces an error from the ticket-id lookup without attempting any update", async () => {
    const supabase = makeSupabase({ ticketed: { error: "boom" } });
    const result = await open(supabase, conv(), "agent-1");
    expect(result).toEqual({ outcome: "error", error: "boom" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("surfaces an error from the claim update", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      updateResults: [{ data: null, error: "db-error" }],
    });
    const result = await open(supabase, conv(), "agent-1");
    expect(result).toEqual({ outcome: "error", error: "db-error" });
  });
});

describe("sweepStaleConversations", () => {
  it("reverts a stale in_progress conversation with no ticket", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      selectResult: {
        data: [
          {
            id: "c1",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: "2000-01-01T00:00:00.000Z" }],
          },
        ],
        error: null,
      },
      updateResults: [{ data: null, error: null }],
    });
    const result = await sweep(supabase);
    expect(result).toEqual({ reverted: ["c1"], errors: [] });
  });

  it("skips a stale conversation that already has a ticket, without attempting an update", async () => {
    const onUpdate = vi.fn();
    const supabase = makeSupabase({
      ticketed: ["c1"],
      selectResult: {
        data: [
          {
            id: "c1",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: "2000-01-01T00:00:00.000Z" }],
          },
        ],
        error: null,
      },
      onUpdate,
    });
    const result = await sweep(supabase);
    expect(result).toEqual({ reverted: [], errors: [] });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not touch a conversation whose last message is from the agent", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      selectResult: {
        data: [
          {
            id: "c1",
            status: "in_progress",
            messages: [{ sender_type: "agent", created_at: "2000-01-01T00:00:00.000Z" }],
          },
        ],
        error: null,
      },
    });
    const result = await sweep(supabase);
    expect(result).toEqual({ reverted: [], errors: [] });
  });

  it("does not touch a conversation still inside the 10-minute window", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      selectResult: {
        data: [
          {
            id: "c1",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: new Date().toISOString() }],
          },
        ],
        error: null,
      },
    });
    const result = await sweep(supabase);
    expect(result).toEqual({ reverted: [], errors: [] });
  });

  it("reverts multiple qualifying conversations and keeps a non-matching one out of the result", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      selectResult: {
        data: [
          {
            id: "stale-1",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: "2000-01-01T00:00:00.000Z" }],
          },
          {
            id: "answered",
            status: "in_progress",
            messages: [{ sender_type: "agent", created_at: "2000-01-01T00:00:00.000Z" }],
          },
          {
            id: "stale-2",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: "2000-01-01T00:00:00.000Z" }],
          },
        ],
        error: null,
      },
      updateResults: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    const result = await sweep(supabase);
    expect(result.reverted.sort()).toEqual(["stale-1", "stale-2"]);
    expect(result.errors).toEqual([]);
  });

  it("collects a per-row error without failing the whole sweep", async () => {
    const supabase = makeSupabase({
      ticketed: [],
      selectResult: {
        data: [
          {
            id: "c1",
            status: "in_progress",
            messages: [{ sender_type: "customer", created_at: "2000-01-01T00:00:00.000Z" }],
          },
        ],
        error: null,
      },
      updateResults: [{ data: null, error: "row-failed" }],
    });
    const result = await sweep(supabase);
    expect(result).toEqual({
      reverted: [],
      errors: [{ conversationId: "c1", error: "row-failed" }],
    });
  });
});
