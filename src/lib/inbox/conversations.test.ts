import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONVERSATION_SELECT,
  countConversationsByStatus,
  effectiveActiveTicket,
  fetchConversationActiveTicket,
  matchesContactFilters,
  matchesInboxFilters,
  moveConversationToTop,
  normalizeConversation,
  pickActiveTicket,
  reconcileLoadedConversations,
  shouldRollbackConversationPreview,
  sortConversationsByRecentActivity,
  updateConversationPreview,
} from "./conversations";
import { resolveAssignChangeAction, resolveStatusChangeAction } from "./ticket-sync";
import type {
  ActiveConversationTicket,
  Conversation,
  ConversationStatus,
} from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "pending",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "pending" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "pending" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });

  // 068 Etapa 2 — the `tickets(...)` embed is unfiltered (see
  // CONVERSATION_SELECT's doc comment), so normalizeConversation must
  // pick out the one active row itself.
  it("picks the open/pending ticket out of the embedded tickets array as active_ticket", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "in_progress" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
      tickets: [
        { id: "t-old", status: "closed" as const, assigned_agent_id: null, queue_id: "q1" },
        { id: "t-active", status: "open" as const, assigned_agent_id: "u9", queue_id: "q1" },
      ],
    };
    expect(normalizeConversation(raw).active_ticket).toEqual({
      id: "t-active",
      status: "open",
      assigned_agent_id: "u9",
      queue_id: "q1",
    });
  });

  it("sets active_ticket to null when every embedded ticket is closed", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "closed" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
      tickets: [
        { id: "t-old", status: "closed" as const, assigned_agent_id: null, queue_id: null },
      ],
    };
    expect(normalizeConversation(raw).active_ticket).toBeNull();
  });

  it("sets active_ticket to null when the tickets embed is absent/empty", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "pending" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    expect(normalizeConversation(raw).active_ticket).toBeNull();
    expect(normalizeConversation({ ...raw, tickets: [] }).active_ticket).toBeNull();
  });
});

describe("pickActiveTicket", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(pickActiveTicket(null)).toBeNull();
    expect(pickActiveTicket(undefined)).toBeNull();
    expect(pickActiveTicket([])).toBeNull();
  });

  it("defensively returns only the first active match if somehow more than one exists", () => {
    const tickets = [
      { id: "t1", status: "open" as const, assigned_agent_id: null, queue_id: null },
      { id: "t2", status: "pending" as const, assigned_agent_id: "u1", queue_id: null },
    ];
    expect(pickActiveTicket(tickets)?.id).toBe("t1");
  });
});

function conv(id: string, unread_count: number): Conversation {
  return {
    id,
    user_id: "u1",
    contact_id: `ct-${id}`,
    status: "pending",
    unread_count,
    created_at: "",
    updated_at: "",
  };
}

describe("reconcileLoadedConversations", () => {
  it("forces unread_count to 0 for the active conversation, even when the fresh row still carries a stale nonzero count", () => {
    const loaded = [conv("a", 3), conv("b", 1)];

    const result = reconcileLoadedConversations(loaded, "a");

    expect(result.find((c) => c.id === "a")?.unread_count).toBe(0);
  });

  it("leaves every other conversation's unread_count exactly as fetched — a genuinely new message elsewhere is never masked", () => {
    const loaded = [conv("a", 3), conv("b", 1)];

    const result = reconcileLoadedConversations(loaded, "a");

    expect(result.find((c) => c.id === "b")?.unread_count).toBe(1);
  });

  it("is a no-op when there is no active conversation", () => {
    const loaded = [conv("a", 3), conv("b", 1)];

    const result = reconcileLoadedConversations(loaded, null);

    expect(result).toEqual(loaded);
  });

  it("is a no-op when the active conversation id matches nothing in the loaded list", () => {
    const loaded = [conv("a", 3), conv("b", 1)];

    const result = reconcileLoadedConversations(loaded, "does-not-exist");

    expect(result).toEqual(loaded);
  });

  it("does not mutate the input array", () => {
    const loaded = [conv("a", 3)];

    reconcileLoadedConversations(loaded, "a");

    expect(loaded[0].unread_count).toBe(3);
  });
});

function fullConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "pending",
    unread_count: 0,
    assigned_agent_id: undefined,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("matchesInboxFilters", () => {
  it("status 'all' matches every status", () => {
    for (const status of ["pending", "in_progress", "waiting_customer", "closed", "finalized"] as ConversationStatus[]) {
      expect(
        matchesInboxFilters(fullConv({ status }), { status: "all", unreadOnly: false, assigneeId: null }),
      ).toBe(true);
    }
  });

  it("filters by exact status", () => {
    expect(
      matchesInboxFilters(fullConv({ status: "in_progress" }), {
        status: "in_progress",
        unreadOnly: false,
        assigneeId: null,
      }),
    ).toBe(true);
    expect(
      matchesInboxFilters(fullConv({ status: "pending" }), {
        status: "in_progress",
        unreadOnly: false,
        assigneeId: null,
      }),
    ).toBe(false);
  });

  it("unreadOnly excludes conversations with unread_count 0, independent of status", () => {
    expect(
      matchesInboxFilters(fullConv({ unread_count: 0 }), { status: "all", unreadOnly: true, assigneeId: null }),
    ).toBe(false);
    expect(
      matchesInboxFilters(fullConv({ unread_count: 2 }), { status: "all", unreadOnly: true, assigneeId: null }),
    ).toBe(true);
  });

  it("changing status never affects the unread filter and vice versa (independent axes)", () => {
    const conv = fullConv({ status: "closed", unread_count: 3 });
    expect(
      matchesInboxFilters(conv, { status: "closed", unreadOnly: true, assigneeId: null }),
    ).toBe(true);
    expect(
      matchesInboxFilters({ ...conv, status: "finalized" }, { status: "closed", unreadOnly: true, assigneeId: null }),
    ).toBe(false);
    // Unread filter alone is unaffected by the status change above.
    expect(
      matchesInboxFilters({ ...conv, status: "finalized" }, { status: "all", unreadOnly: true, assigneeId: null }),
    ).toBe(true);
  });

  it("'unassigned' matches only conversations with no assigned_agent_id", () => {
    expect(
      matchesInboxFilters(fullConv({ assigned_agent_id: undefined }), {
        status: "all",
        unreadOnly: false,
        assigneeId: "unassigned",
      }),
    ).toBe(true);
    expect(
      matchesInboxFilters(fullConv({ assigned_agent_id: "agent-1" }), {
        status: "all",
        unreadOnly: false,
        assigneeId: "unassigned",
      }),
    ).toBe(false);
  });

  it("a specific assigneeId matches only that exact agent", () => {
    expect(
      matchesInboxFilters(fullConv({ assigned_agent_id: "agent-1" }), {
        status: "all",
        unreadOnly: false,
        assigneeId: "agent-1",
      }),
    ).toBe(true);
    expect(
      matchesInboxFilters(fullConv({ assigned_agent_id: "agent-2" }), {
        status: "all",
        unreadOnly: false,
        assigneeId: "agent-1",
      }),
    ).toBe(false);
  });

  it("combines all three filters (AND)", () => {
    const conv = fullConv({ status: "in_progress", unread_count: 1, assigned_agent_id: "agent-1" });
    expect(
      matchesInboxFilters(conv, { status: "in_progress", unreadOnly: true, assigneeId: "agent-1" }),
    ).toBe(true);
    expect(
      matchesInboxFilters(conv, { status: "in_progress", unreadOnly: true, assigneeId: "agent-2" }),
    ).toBe(false);
  });
});

describe("countConversationsByStatus", () => {
  it("counts each status independently, ignoring search/tag/company/unread/assignee", () => {
    const counts = countConversationsByStatus([
      fullConv({ status: "pending" }),
      fullConv({ status: "pending" }),
      fullConv({ status: "in_progress" }),
      fullConv({ status: "closed" }),
    ]);
    expect(counts).toEqual({
      pending: 2,
      in_progress: 1,
      waiting_customer: 0,
      closed: 1,
      finalized: 0,
    });
  });

  it("returns all-zero counts for an empty list", () => {
    expect(countConversationsByStatus([])).toEqual({
      pending: 0,
      in_progress: 0,
      waiting_customer: 0,
      closed: 0,
      finalized: 0,
    });
  });
});

describe("updateConversationPreview", () => {
  it("patches only the matching conversation's preview fields", () => {
    const list = [
      fullConv({ id: "a", last_message_text: "old a", last_message_at: "t0" }),
      fullConv({ id: "b", last_message_text: "old b", last_message_at: "t0" }),
    ];

    const result = updateConversationPreview(list, "a", {
      last_message_text: "new a",
      last_message_at: "t1",
    });

    expect(result.find((c) => c.id === "a")).toMatchObject({
      last_message_text: "new a",
      last_message_at: "t1",
    });
    // The other conversation is untouched — same reference even.
    expect(result.find((c) => c.id === "b")).toBe(list[1]);
  });

  it("updates the timestamp so a stale-looking conversation reflects the new activity", () => {
    const list = [fullConv({ id: "a", last_message_at: "2020-01-01T00:00:00.000Z" })];
    const now = "2026-08-12T12:00:00.000Z";

    const result = updateConversationPreview(list, "a", { last_message_at: now });

    expect(result[0].last_message_at).toBe(now);
  });

  it("is a no-op (in content) when the id doesn't match anything", () => {
    const list = [fullConv({ id: "a" })];
    const result = updateConversationPreview(list, "missing", {
      last_message_text: "x",
    });
    expect(result).toEqual(list);
  });

  it("does not mutate the input array", () => {
    const list = [fullConv({ id: "a", last_message_text: "old" })];
    updateConversationPreview(list, "a", { last_message_text: "new" });
    expect(list[0].last_message_text).toBe("old");
  });
});

describe("moveConversationToTop", () => {
  it("moves a conversation from the middle to the front, preserving the relative order of the rest", () => {
    const list = [fullConv({ id: "a" }), fullConv({ id: "b" }), fullConv({ id: "c" })];

    const result = moveConversationToTop(list, "b");

    expect(result.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("moves the last conversation to the front", () => {
    const list = [fullConv({ id: "a" }), fullConv({ id: "b" }), fullConv({ id: "c" })];

    const result = moveConversationToTop(list, "c");

    expect(result.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when the conversation is already first", () => {
    const list = [fullConv({ id: "a" }), fullConv({ id: "b" })];

    const result = moveConversationToTop(list, "a");

    expect(result).toBe(list);
  });

  it("is a no-op when the id doesn't match anything", () => {
    const list = [fullConv({ id: "a" }), fullConv({ id: "b" })];

    const result = moveConversationToTop(list, "missing");

    expect(result).toBe(list);
  });

  it("never duplicates or drops conversations", () => {
    const list = [fullConv({ id: "a" }), fullConv({ id: "b" }), fullConv({ id: "c" })];

    const result = moveConversationToTop(list, "b");

    expect(result).toHaveLength(3);
    expect(new Set(result.map((c) => c.id))).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("optimistic activity bump (updateConversationPreview + moveConversationToTop composed)", () => {
  // This mirrors exactly what page.tsx's handleConversationActivity,
  // handleMessageEvent, and handleConversationEvent do: patch the
  // conversation's preview, then move it to the front.
  function bump(
    list: Conversation[],
    id: string,
    patch: Parameters<typeof updateConversationPreview>[2],
  ) {
    return moveConversationToTop(updateConversationPreview(list, id, patch), id);
  }

  it("a new message in the oldest conversation brings it to the top", () => {
    const list = [
      fullConv({ id: "newest", last_message_at: "2026-08-12T10:00:00.000Z" }),
      fullConv({ id: "middle", last_message_at: "2026-08-12T09:00:00.000Z" }),
      fullConv({ id: "oldest", last_message_at: "2020-01-01T00:00:00.000Z" }),
    ];

    const result = bump(list, "oldest", {
      last_message_text: "hey!",
      last_message_at: "2026-08-12T11:00:00.000Z",
    });

    expect(result.map((c) => c.id)).toEqual(["oldest", "newest", "middle"]);
    expect(result[0].last_message_text).toBe("hey!");
  });

  it("an outbound optimistic send bumps the conversation the same way an inbound message would", () => {
    const list = [
      fullConv({ id: "other", last_message_at: "2026-08-12T10:00:00.000Z" }),
      fullConv({ id: "active", last_message_at: "2026-08-12T09:00:00.000Z" }),
    ];

    const result = bump(list, "active", {
      last_message_text: "Sure, sending it now",
      last_message_at: "2026-08-12T11:00:00.000Z",
    });

    expect(result.map((c) => c.id)).toEqual(["active", "other"]);
  });

  it("does not duplicate the conversation when it's bumped repeatedly", () => {
    let list = [fullConv({ id: "a" }), fullConv({ id: "b" })];

    list = bump(list, "b", { last_message_text: "1" });
    list = bump(list, "b", { last_message_text: "2" });

    expect(list).toHaveLength(2);
    expect(list.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("shouldRollbackConversationPreview", () => {
  it("allows the rollback when nothing newer has landed since the optimistic bump", () => {
    const list = [fullConv({ id: "a", last_message_at: "optimistic-ts" })];
    expect(
      shouldRollbackConversationPreview(list, "a", "optimistic-ts"),
    ).toBe(true);
  });

  it("blocks the rollback when a genuinely newer message already landed for the conversation", () => {
    // Simulates: optimistic send at t1 fails, but a real message (inbound
    // or another outbound send) already bumped last_message_at to t2
    // before the failure/rollback callback ran.
    const list = [fullConv({ id: "a", last_message_at: "t2-real-message" })];
    expect(
      shouldRollbackConversationPreview(list, "a", "t1-optimistic"),
    ).toBe(false);
  });

  it("blocks the rollback when the conversation id can't be found", () => {
    const list = [fullConv({ id: "a", last_message_at: "t1" })];
    expect(
      shouldRollbackConversationPreview(list, "missing", "t1"),
    ).toBe(false);
  });
});

describe("rollback after a failed optimistic send", () => {
  function bump(
    list: Conversation[],
    id: string,
    patch: Parameters<typeof updateConversationPreview>[2],
  ) {
    return moveConversationToTop(updateConversationPreview(list, id, patch), id);
  }

  it("restores the previous preview without duplicating or dropping conversations", () => {
    const original = [
      fullConv({ id: "a", last_message_text: "last real message", last_message_at: "t0" }),
      fullConv({ id: "b", last_message_text: "b's message", last_message_at: "t-1" }),
    ];

    // Optimistic send: bump "a" to the top with the (about to fail) draft.
    const optimistic = bump(original, "a", {
      last_message_text: "this send will fail",
      last_message_at: "t1-optimistic",
    });
    expect(optimistic.map((c) => c.id)).toEqual(["a", "b"]);

    // Failure callback fires: nothing newer landed, so the rollback applies.
    const canRollback = shouldRollbackConversationPreview(
      optimistic,
      "a",
      "t1-optimistic",
    );
    expect(canRollback).toBe(true);

    const rolledBack = canRollback
      ? updateConversationPreview(optimistic, "a", {
          last_message_text: "last real message",
          last_message_at: "t0",
        })
      : optimistic;

    expect(rolledBack).toHaveLength(2);
    expect(rolledBack.find((c) => c.id === "a")).toMatchObject({
      last_message_text: "last real message",
      last_message_at: "t0",
    });
    // The failed draft text is gone — no misleading "sent" preview left behind.
    expect(
      rolledBack.some((c) => c.last_message_text === "this send will fail"),
    ).toBe(false);
  });

  it("skips the rollback instead of clobbering a genuinely newer message that arrived in between", () => {
    const original = [fullConv({ id: "a", last_message_text: "old", last_message_at: "t0" })];

    const optimistic = bump(original, "a", {
      last_message_text: "this send will fail",
      last_message_at: "t1-optimistic",
    });

    // A real message (e.g. the customer replying) lands before the
    // failure callback runs, bumping last_message_at past t1-optimistic.
    const withRealMessage = bump(optimistic, "a", {
      last_message_text: "actual customer reply",
      last_message_at: "t2-real",
    });

    const canRollback = shouldRollbackConversationPreview(
      withRealMessage,
      "a",
      "t1-optimistic",
    );
    expect(canRollback).toBe(false);

    // The real message's preview must survive untouched.
    expect(withRealMessage[0].last_message_text).toBe("actual customer reply");
  });
});

describe("sortConversationsByRecentActivity", () => {
  it("orders strictly newest-first, never oldest-first", () => {
    const list = [
      fullConv({ id: "old", last_message_at: "2020-01-01T00:00:00.000Z" }),
      fullConv({ id: "newest", last_message_at: "2026-08-12T12:00:00.000Z" }),
      fullConv({ id: "middle", last_message_at: "2026-08-12T09:00:00.000Z" }),
    ];

    const result = sortConversationsByRecentActivity(list);

    expect(result.map((c) => c.id)).toEqual(["newest", "middle", "old"]);
  });

  it("the exact scenario from the bug report: [old A, old B, new C], activity on B moves it to the top", () => {
    const original = [
      fullConv({ id: "A", last_message_at: "2026-08-10T08:00:00.000Z" }), // oldest
      fullConv({ id: "B", last_message_at: "2026-08-11T08:00:00.000Z" }), // middle
      fullConv({ id: "C", last_message_at: "2026-08-12T08:00:00.000Z" }), // newest of the three, initially
    ];
    expect(sortConversationsByRecentActivity(original).map((c) => c.id)).toEqual([
      "C",
      "B",
      "A",
    ]);

    // Activity lands on B — this mirrors exactly what page.tsx's
    // handleMessageEvent does: patch the preview, then bump position.
    // The bump alone is enough for the incremental array to already be
    // correct; sortConversationsByRecentActivity is what the render
    // layer actually uses, and must land on the identical order.
    const bumped = moveConversationToTop(
      updateConversationPreview(original, "B", {
        last_message_at: "2026-08-12T12:00:00.000Z", // newer than C now
      }),
      "B",
    );

    const rendered = sortConversationsByRecentActivity(bumped);

    // B is the most recent activity now -> position 0. C (still
    // 2026-08-12T08:00) is next, A (oldest, untouched) stays last.
    // Never oldest-first, never A or C ahead of the conversation that
    // just had real activity.
    expect(rendered.map((c) => c.id)).toEqual(["B", "C", "A"]);
  });

  it("a conversation with no last_message_at (never messaged) sorts LAST, not first", () => {
    const list = [
      fullConv({ id: "never-messaged", last_message_at: undefined }),
      fullConv({ id: "has-old-activity", last_message_at: "2020-01-01T00:00:00.000Z" }),
    ];

    const result = sortConversationsByRecentActivity(list);

    // Postgres's default NULLS FIRST for `ORDER BY ... DESC` would put
    // "never-messaged" ahead of a conversation with real (even old)
    // activity — this function deliberately overrides that: no
    // activity at all is the least recent, not the most.
    expect(result.map((c) => c.id)).toEqual(["has-old-activity", "never-messaged"]);
  });

  it("is a stable sort — ties keep their original relative order", () => {
    const sameTimestamp = "2026-08-12T10:00:00.000Z";
    const list = [
      fullConv({ id: "first", last_message_at: sameTimestamp }),
      fullConv({ id: "second", last_message_at: sameTimestamp }),
      fullConv({ id: "third", last_message_at: sameTimestamp }),
    ];

    const result = sortConversationsByRecentActivity(list);

    expect(result.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the input array", () => {
    const list = [
      fullConv({ id: "a", last_message_at: "2020-01-01T00:00:00.000Z" }),
      fullConv({ id: "b", last_message_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const original = [...list];

    sortConversationsByRecentActivity(list);

    expect(list).toEqual(original);
  });

  it("never leaves the list in reverse (oldest-first) order", () => {
    const list = [
      fullConv({ id: "a", last_message_at: "2026-08-01T00:00:00.000Z" }),
      fullConv({ id: "b", last_message_at: "2026-08-05T00:00:00.000Z" }),
      fullConv({ id: "c", last_message_at: "2026-08-10T00:00:00.000Z" }),
    ];

    const result = sortConversationsByRecentActivity(list);
    const timestamps = result.map((c) => new Date(c.last_message_at!).getTime());

    // Each timestamp must be >= the next one — monotonically
    // non-increasing, i.e. never ascending/oldest-first anywhere.
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// 068 Etapa 2 — P1: re-reading active_ticket after an Inbox ticket action
// ---------------------------------------------------------------------------

const TICKET: ActiveConversationTicket = {
  id: "t1",
  status: "open",
  assigned_agent_id: null,
  queue_id: "q1",
};

/**
 * Minimal stand-in for the one chain fetchConversationActiveTicket uses:
 * from("conversations").select(...).eq("id", ...).maybeSingle().
 * `row` is what the DB holds AFTER the ticket RPC ran.
 */
function mockConversationRead(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as SupabaseClient, from, select, eq };
}

function rowWithTickets(tickets: ActiveConversationTicket[]) {
  return {
    ...makeConversation(null),
    contact: undefined,
    tickets,
  };
}

async function refetched(tickets: ActiveConversationTicket[]) {
  const { client } = mockConversationRead({ data: rowWithTickets(tickets), error: null });
  const result = await fetchConversationActiveTicket(client, "c1");
  if (!result) throw new Error("expected a successful read");
  return result.activeTicket;
}

describe("fetchConversationActiveTicket", () => {
  it("re-reads the conversation with CONVERSATION_SELECT, by id", async () => {
    const m = mockConversationRead({ data: rowWithTickets([TICKET]), error: null });
    await fetchConversationActiveTicket(m.client, "c1");
    expect(m.from).toHaveBeenCalledWith("conversations");
    expect(m.select).toHaveBeenCalledWith(CONVERSATION_SELECT);
    expect(m.eq).toHaveBeenCalledWith("id", "c1");
  });

  it("after close: the ticket is no longer active (null)", async () => {
    expect(await refetched([{ ...TICKET, status: "closed", assigned_agent_id: "me" }])).toBeNull();
  });

  it("after claim: assigned_agent_id reflects the new assignee", async () => {
    expect(await refetched([{ ...TICKET, assigned_agent_id: "me" }])).toMatchObject({
      id: "t1",
      status: "open",
      assigned_agent_id: "me",
    });
  });

  it("after transfer-agent: assigned_agent_id reflects the new agent", async () => {
    expect(await refetched([{ ...TICKET, assigned_agent_id: "agent-2" }])).toMatchObject({
      assigned_agent_id: "agent-2",
    });
  });

  it("after waiting-customer / resume: status reflects the ticket's new state", async () => {
    expect(await refetched([{ ...TICKET, status: "pending", assigned_agent_id: "me" }])).toMatchObject({
      status: "pending",
    });
    expect(await refetched([{ ...TICKET, status: "open", assigned_agent_id: "me" }])).toMatchObject({
      status: "open",
    });
  });

  it("returns null (keep current state) when the read errors", async () => {
    const { client } = mockConversationRead({ data: null, error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fetchConversationActiveTicket(client, "c1")).toBeNull();
    spy.mockRestore();
  });

  it("returns null (keep current state) when the row is not found", async () => {
    const { client } = mockConversationRead({ data: null, error: null });
    expect(await fetchConversationActiveTicket(client, "c1")).toBeNull();
  });
});

describe("effectiveActiveTicket", () => {
  const stale: ActiveConversationTicket = { ...TICKET };
  const conv = { id: "c1", active_ticket: stale };

  it("without an override, uses the conversation's own active_ticket (unchanged behaviour)", () => {
    expect(effectiveActiveTicket(conv, null)).toBe(stale);
    expect(effectiveActiveTicket({ id: "c1", active_ticket: null }, null)).toBeNull();
    expect(effectiveActiveTicket({ id: "c1" }, null)).toBeNull();
  });

  it("applies an override taken for this conversation against the same active_ticket", () => {
    const fresh = { ...TICKET, assigned_agent_id: "me" };
    expect(
      effectiveActiveTicket(conv, { conversationId: "c1", base: stale, activeTicket: fresh }),
    ).toBe(fresh);
  });

  it("applies a null override (ticket closed) the same way", () => {
    expect(
      effectiveActiveTicket(conv, { conversationId: "c1", base: stale, activeTicket: null }),
    ).toBeNull();
  });

  it("survives a realtime merge / local patch that spreads the old object", () => {
    const fresh = { ...TICKET, assigned_agent_id: "me" };
    const merged = { ...conv, status: "in_progress" as ConversationStatus };
    expect(
      effectiveActiveTicket(merged, { conversationId: "c1", base: stale, activeTicket: fresh }),
    ).toBe(fresh);
  });

  it("ignores an override that belongs to another conversation", () => {
    expect(
      effectiveActiveTicket(conv, { conversationId: "c2", base: stale, activeTicket: null }),
    ).toBe(stale);
  });

  it("yields to a list reload (new active_ticket reference) fetched after the override", () => {
    const reloaded = { ...TICKET, status: "pending" as const };
    expect(
      effectiveActiveTicket(
        { id: "c1", active_ticket: reloaded },
        { conversationId: "c1", base: stale, activeTicket: null },
      ),
    ).toBe(reloaded);
  });
});

describe("P1 — the next Inbox action is classified against the refreshed ticket", () => {
  const stale: ActiveConversationTicket = { ...TICKET }; // open, unassigned
  const conv = { id: "c1", active_ticket: stale };
  const withFresh = (fresh: ActiveConversationTicket | null) =>
    effectiveActiveTicket(conv, { conversationId: "c1", base: stale, activeTicket: fresh });

  it("after claim, reassigning to another agent is a transfer (stale ticket said unavailable)", () => {
    expect(resolveAssignChangeAction(stale, "agent-2", "me").kind).toBe("unavailable");
    expect(
      resolveAssignChangeAction(withFresh({ ...TICKET, assigned_agent_id: "me" }), "agent-2", "me"),
    ).toEqual({ kind: "ticket-rpc", op: "transfer_agent", agentUserId: "agent-2" });
  });

  it("after close, 'pending' is no longer blocked by the closed ticket", () => {
    expect(resolveStatusChangeAction(stale, "pending").kind).toBe("unavailable");
    expect(resolveStatusChangeAction(withFresh(null), "pending").kind).toBe("direct");
  });

  it("after waiting-customer, in_progress maps to resume", () => {
    const pending = { ...TICKET, status: "pending" as const, assigned_agent_id: "me" };
    expect(resolveStatusChangeAction(withFresh(pending), "in_progress")).toEqual({
      kind: "ticket-rpc",
      op: "resume",
    });
  });
});
