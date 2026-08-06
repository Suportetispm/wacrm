import { describe, it, expect } from "vitest";
import {
  countConversationsByStatus,
  matchesContactFilters,
  matchesInboxFilters,
  normalizeConversation,
  reconcileLoadedConversations,
} from "./conversations";
import type { Conversation, ConversationStatus } from "@/types";

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
