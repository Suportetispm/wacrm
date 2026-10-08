import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFS,
  applyConversationChange,
  applyConversationDelete,
  buildMirror,
  buildNotificationContent,
  defaultOnlyMineForRole,
  inboxConversationUrl,
  isCoolingDown,
  isFreshActivity,
  isInNotifierScope,
  isViewingConversation,
  parseNotificationPrefs,
  reconcileSnapshot,
  resolveOnlyMine,
  serializeNotificationPrefs,
  type NotificationCopy,
  type NotifierConversationRow,
  type NotifierScope,
  type ViewerState,
} from "./browser-notify";

const ACCOUNT = "acc-1";
const OTHER_ACCOUNT = "acc-2";
const ME = "user-me";

const T0 = "2026-10-08T10:00:00.000Z"; // newest activity at start-up
const BEFORE = "2026-10-08T09:00:00.000Z";
const AFTER = "2026-10-08T10:05:00.000Z";

function row(overrides: Partial<NotifierConversationRow> & { id: string }): NotifierConversationRow {
  return {
    account_id: ACCOUNT,
    unread_count: 0,
    created_at: BEFORE,
    last_message_at: BEFORE,
    queue_id: null,
    assigned_agent_id: null,
    contact_id: "contact-1",
    last_message_text: "Olá, preciso de ajuda com meu pedido",
    ...overrides,
  };
}

const COPY: NotificationCopy = {
  messageTitle: "Nova mensagem",
  messageBody: "Você recebeu uma nova mensagem.",
  newConversationTitle: "Novo atendimento",
  newConversationBody: "Um novo atendimento chegou.",
  previewFallbackBody: "Nova mensagem recebida.",
};

describe("notification prefs", () => {
  it("defaults are all off and onlyMine follows the role", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      enabled: false,
      sound: false,
      showPreview: false,
      onlyMine: null,
    });
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("falls back to defaults on malformed storage", () => {
    expect(parseNotificationPrefs("not json")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("42")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs('{"enabled":"yes","sound":1}')).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("round-trips through serialize/parse", () => {
    const prefs = { enabled: true, sound: true, showPreview: false, onlyMine: false };
    expect(parseNotificationPrefs(serializeNotificationPrefs(prefs))).toEqual(prefs);
  });

  it("onlyMine is on by default for owner/admin and off for agent/viewer", () => {
    expect(defaultOnlyMineForRole("owner")).toBe(true);
    expect(defaultOnlyMineForRole("admin")).toBe(true);
    expect(defaultOnlyMineForRole("agent")).toBe(false);
    expect(defaultOnlyMineForRole("viewer")).toBe(false);
    expect(defaultOnlyMineForRole(null)).toBe(false);
  });

  it("an explicit choice overrides the role default", () => {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, onlyMine: false };
    expect(resolveOnlyMine(prefs, "admin")).toBe(false);
    expect(resolveOnlyMine({ ...prefs, onlyMine: true }, "agent")).toBe(true);
    expect(resolveOnlyMine(DEFAULT_NOTIFICATION_PREFS, "admin")).toBe(true);
  });
});

describe("start-up snapshot", () => {
  it("never announces historical conversations, even unread ones", () => {
    const mirror = buildMirror([
      row({ id: "a", unread_count: 5, last_message_at: T0 }),
      row({ id: "b", unread_count: 0 }),
    ]);
    // Same values re-delivered by realtime (e.g. a status flip) → nothing.
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: 5, last_message_at: T0 }))).toBeNull();
    expect(applyConversationChange(mirror, row({ id: "b", unread_count: 0 }))).toBeNull();
  });

  it("watermark is the newest server timestamp in the snapshot", () => {
    const mirror = buildMirror([
      row({ id: "a", created_at: BEFORE, last_message_at: T0 }),
      row({ id: "b", created_at: BEFORE, last_message_at: BEFORE }),
    ]);
    expect(mirror.watermark).toBe(Date.parse(T0));
    expect(buildMirror([]).watermark).toBeNull();
  });
});

describe("applyConversationChange", () => {
  it("alerts 'message' when unread_count really goes up", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 1, last_message_at: T0 })]);
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: 2, last_message_at: AFTER }))).toBe(
      "message",
    );
  });

  it("does not alert on agent sends (last_message_* moves, unread does not)", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 0, last_message_at: T0 })]);
    expect(
      applyConversationChange(
        mirror,
        row({ id: "a", unread_count: 0, last_message_at: AFTER, last_message_text: "resposta do atendente" }),
      ),
    ).toBeNull();
  });

  it("does not alert when the conversation is read (unread goes down) and alerts on the next inbound", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 3, last_message_at: T0 })]);
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: 0 }))).toBeNull();
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: 1, last_message_at: AFTER }))).toBe(
      "message",
    );
  });

  it("does not alert on status / assignment / sector changes alone", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 2, last_message_at: T0 })]);
    expect(
      applyConversationChange(mirror, row({ id: "a", unread_count: 2, assigned_agent_id: ME, queue_id: "q1" })),
    ).toBeNull();
  });

  it("new inbound conversation: INSERT with unread 0, then +1 → one 'new_conversation'", () => {
    const mirror = buildMirror([row({ id: "old", last_message_at: T0 })]);
    expect(
      applyConversationChange(mirror, row({ id: "new", unread_count: 0, created_at: AFTER, last_message_at: null })),
    ).toBeNull();
    expect(
      applyConversationChange(mirror, row({ id: "new", unread_count: 1, created_at: AFTER, last_message_at: AFTER })),
    ).toBe("new_conversation");
    // Follow-up messages on it are plain messages.
    expect(
      applyConversationChange(mirror, row({ id: "new", unread_count: 2, created_at: AFTER, last_message_at: AFTER })),
    ).toBe("message");
  });

  it("conversation that becomes visible with fresh unread activity (routed into my sector) → 'new_conversation'", () => {
    const mirror = buildMirror([row({ id: "old", last_message_at: T0 })]);
    expect(
      applyConversationChange(
        mirror,
        row({ id: "routed", unread_count: 1, created_at: AFTER, last_message_at: AFTER, queue_id: "q1" }),
      ),
    ).toBe("new_conversation");
  });

  it("an unknown OLD conversation surfacing (e.g. transfer, sweep) is not announced", () => {
    const mirror = buildMirror([row({ id: "x", last_message_at: T0 })]);
    expect(
      applyConversationChange(
        mirror,
        row({ id: "transferred", unread_count: 4, created_at: BEFORE, last_message_at: BEFORE }),
      ),
    ).toBeNull();
    // ...but a later inbound on it is.
    expect(
      applyConversationChange(
        mirror,
        row({ id: "transferred", unread_count: 5, created_at: BEFORE, last_message_at: AFTER }),
      ),
    ).toBe("message");
  });

  it("empty snapshot → any later activity is fresh", () => {
    const mirror = buildMirror([]);
    expect(isFreshActivity(row({ id: "a" }), mirror.watermark)).toBe(true);
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: 1 }))).toBe("new_conversation");
  });

  it("ignores bogus unread values", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: null })]);
    expect(applyConversationChange(mirror, row({ id: "a", unread_count: -3 }))).toBeNull();
  });

  it("delete forgets the conversation", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 1, last_message_at: T0 })]);
    applyConversationDelete(mirror, "a");
    expect(mirror.entries.has("a")).toBe(false);
    applyConversationDelete(mirror, undefined);
  });
});

describe("reconcileSnapshot (reconnect catch-up)", () => {
  const all = () => true;

  it("counts conversations with missed inbound activity once each, never per message", () => {
    const mirror = buildMirror([
      row({ id: "a", unread_count: 1, last_message_at: T0 }),
      row({ id: "b", unread_count: 0 }),
      row({ id: "c", unread_count: 2 }),
    ]);
    const { count, mirror: next } = reconcileSnapshot(
      mirror,
      [
        row({ id: "a", unread_count: 6, last_message_at: AFTER }), // +5 messages → 1
        row({ id: "b", unread_count: 0 }), // nothing
        row({ id: "c", unread_count: 0 }), // read meanwhile
        row({ id: "d", unread_count: 1, created_at: AFTER, last_message_at: AFTER }), // new
      ],
      all,
    );
    expect(count).toBe(2);
    // The replacement mirror carries the new values: re-delivery → nothing.
    expect(applyConversationChange(next, row({ id: "a", unread_count: 6, last_message_at: AFTER }))).toBeNull();
    expect(
      applyConversationChange(next, row({ id: "d", unread_count: 1, created_at: AFTER, last_message_at: AFTER })),
    ).toBeNull();
  });

  it("respects scope when counting", () => {
    const mirror = buildMirror([row({ id: "a", unread_count: 0, last_message_at: T0 })]);
    const { count } = reconcileSnapshot(
      mirror,
      [row({ id: "a", unread_count: 1, last_message_at: AFTER })],
      () => false,
    );
    expect(count).toBe(0);
  });

  it("returns zero when nothing changed", () => {
    const rows = [row({ id: "a", unread_count: 3, last_message_at: T0 })];
    expect(reconcileSnapshot(buildMirror(rows), rows, all).count).toBe(0);
  });
});

describe("isInNotifierScope", () => {
  const base: NotifierScope = {
    accountId: ACCOUNT,
    userId: ME,
    onlyMine: false,
    myQueueIds: new Set(["q-mine"]),
  };

  it("never lets another account through", () => {
    expect(isInNotifierScope(row({ id: "a", account_id: OTHER_ACCOUNT }), base)).toBe(false);
    expect(isInNotifierScope(row({ id: "a", account_id: null }), base)).toBe(false);
  });

  it("without onlyMine, everything RLS delivered for the account passes", () => {
    expect(isInNotifierScope(row({ id: "a", queue_id: "q-other" }), base)).toBe(true);
    expect(isInNotifierScope(row({ id: "a", queue_id: null }), base)).toBe(true);
  });

  it("with onlyMine, only my sectors or my assignments pass", () => {
    const scope = { ...base, onlyMine: true };
    expect(isInNotifierScope(row({ id: "a", queue_id: "q-mine" }), scope)).toBe(true);
    expect(isInNotifierScope(row({ id: "a", assigned_agent_id: ME, queue_id: "q-other" }), scope)).toBe(true);
    expect(isInNotifierScope(row({ id: "a", queue_id: "q-other" }), scope)).toBe(false);
    expect(isInNotifierScope(row({ id: "a", queue_id: null, assigned_agent_id: "someone" }), scope)).toBe(false);
  });
});

describe("isViewingConversation", () => {
  const viewing: ViewerState = { pathname: "/inbox", search: "?c=conv-1", visible: true, focused: true };

  it("true only for a visible, focused tab on /inbox?c=<id>", () => {
    expect(isViewingConversation(viewing, "conv-1")).toBe(true);
    expect(isViewingConversation(viewing, "conv-2")).toBe(false);
    expect(isViewingConversation({ ...viewing, visible: false }, "conv-1")).toBe(false);
    expect(isViewingConversation({ ...viewing, focused: false }, "conv-1")).toBe(false);
    expect(isViewingConversation({ ...viewing, pathname: "/tickets" }, "conv-1")).toBe(false);
    expect(isViewingConversation({ ...viewing, search: "" }, "conv-1")).toBe(false);
  });

  it("builds the deep link the Inbox reads", () => {
    expect(inboxConversationUrl("abc-123")).toBe("/inbox?c=abc-123");
  });
});

describe("buildNotificationContent", () => {
  const r = row({ id: "conv-9", last_message_text: "  Meu CPF é 123.456.789-00  " });

  it("preview OFF (default) exposes no customer data", () => {
    const c = buildNotificationContent("message", r, { showPreview: false, contactName: "Maria Silva" }, COPY);
    expect(c).toEqual({ title: "Nova mensagem", body: "Você recebeu uma nova mensagem.", tag: "wacrm-conv-conv-9" });
    expect(JSON.stringify(c)).not.toContain("Maria");
    expect(JSON.stringify(c)).not.toContain("CPF");
  });

  it("uses the new-conversation copy for new conversations", () => {
    const c = buildNotificationContent("new_conversation", r, { showPreview: false, contactName: null }, COPY);
    expect(c.title).toBe("Novo atendimento");
    expect(c.body).toBe("Um novo atendimento chegou.");
  });

  it("preview ON shows contact name and trimmed text", () => {
    const c = buildNotificationContent("message", r, { showPreview: true, contactName: "Maria Silva" }, COPY);
    expect(c.title).toBe("Maria Silva");
    expect(c.body).toBe("Meu CPF é 123.456.789-00");
  });

  it("preview ON falls back gracefully and truncates long text", () => {
    const empty = buildNotificationContent(
      "message",
      row({ id: "x", last_message_text: null }),
      { showPreview: true, contactName: null },
      COPY,
    );
    expect(empty).toMatchObject({ title: "Nova mensagem", body: "Nova mensagem recebida." });

    const long = buildNotificationContent(
      "message",
      row({ id: "x", last_message_text: "a".repeat(500) }),
      { showPreview: true, contactName: "N" },
      COPY,
    );
    expect(long.body.length).toBe(120);
    expect(long.body.endsWith("…")).toBe(true);
  });

  it("tags per conversation so repeated alerts replace instead of stacking", () => {
    const a = buildNotificationContent("message", row({ id: "same" }), { showPreview: false, contactName: null }, COPY);
    const b = buildNotificationContent("new_conversation", row({ id: "same" }), { showPreview: true, contactName: "X" }, COPY);
    expect(a.tag).toBe(b.tag);
  });
});

describe("isCoolingDown", () => {
  it("suppresses a second alert for the same conversation inside the window", () => {
    const last = new Map([["a", 1000]]);
    expect(isCoolingDown(last, "a", 2000)).toBe(true);
    expect(isCoolingDown(last, "a", 1000 + 4000)).toBe(false);
    expect(isCoolingDown(last, "b", 2000)).toBe(false);
  });
});
