import type { AccountRole } from "@/lib/auth/roles";

/**
 * Pure decision logic for native browser notifications (Fase 1 —
 * notifications while the app is open, no Web Push). No DOM, no
 * Supabase: the client engine (`notifier-engine.ts`) feeds realtime
 * `conversations` rows through these functions and only acts on what
 * they return, so every rule below is unit-testable in node.
 *
 * Signal choice: a conversation's `unread_count` only ever goes UP when
 * a customer message is persisted (the inbound RPCs `unread_count + 1`
 * — 064/084, meta_reopen_conversation_on_inbound). Agent sends, bot and
 * Flow replies never touch it (send-message.ts only bumps
 * last_message_*), and there is no "mark as unread" action. So "unread
 * went up" == "the customer wrote", without subscribing to `messages`.
 */

// ------------------------------------------------------------------
// Preferences (stored per browser — see notification-prefs-store.ts)
// ------------------------------------------------------------------

export interface NotificationPrefs {
  /** Master switch. Off by default — nothing fires until the user opts in. */
  enabled: boolean;
  /** Short beep on top of the popup. Off by default. */
  sound: boolean;
  /** Show contact name + message text. Off by default (privacy). */
  showPreview: boolean;
  /**
   * Only my sectors (active queue_members) and conversations assigned to
   * me. `null` = the user never chose, fall back to the role default
   * (on for owner/admin — they can see every conversation of the
   * account; off for agent/viewer — RLS already narrows them).
   */
  onlyMine: boolean | null;
}

export const NOTIFICATION_PREFS_STORAGE_KEY = "wacrm.notifications";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = Object.freeze({
  enabled: false,
  sound: false,
  showPreview: false,
  onlyMine: null,
});

/** Lenient parse — anything malformed falls back to the defaults. */
export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  if (!value || typeof value !== "object") return { ...DEFAULT_NOTIFICATION_PREFS };
  const v = value as Record<string, unknown>;
  return {
    enabled: v.enabled === true,
    sound: v.sound === true,
    showPreview: v.showPreview === true,
    onlyMine: typeof v.onlyMine === "boolean" ? v.onlyMine : null,
  };
}

export function serializeNotificationPrefs(prefs: NotificationPrefs): string {
  return JSON.stringify({
    enabled: prefs.enabled,
    sound: prefs.sound,
    showPreview: prefs.showPreview,
    onlyMine: prefs.onlyMine,
  });
}

/** Role default for the "only my sectors and assignments" filter. */
export function defaultOnlyMineForRole(role: AccountRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function resolveOnlyMine(
  prefs: NotificationPrefs,
  role: AccountRole | null | undefined,
): boolean {
  return prefs.onlyMine ?? defaultOnlyMineForRole(role);
}

// ------------------------------------------------------------------
// Conversation mirror
// ------------------------------------------------------------------

/** The `conversations` columns the notifier reads (snapshot + realtime). */
export interface NotifierConversationRow {
  id: string;
  account_id?: string | null;
  unread_count?: number | null;
  last_message_at?: string | null;
  created_at?: string | null;
  queue_id?: string | null;
  assigned_agent_id?: string | null;
  contact_id?: string | null;
  last_message_text?: string | null;
}

export const NOTIFIER_SNAPSHOT_COLUMNS =
  "id, account_id, unread_count, last_message_at, created_at, queue_id, assigned_agent_id";

interface MirrorEntry {
  unread: number;
  /** First seen after start-up with activity newer than the watermark. */
  fresh: boolean;
  /** A "new conversation" alert already went out for it. */
  announced: boolean;
}

/**
 * Local copy of `{id → unread_count}` for the conversations this user
 * can see, plus a watermark: the newest server timestamp present in the
 * start-up snapshot. Comparing row timestamps against the watermark
 * (both server clocks) instead of the browser clock keeps a skewed
 * client clock from turning history into "new" alerts.
 */
export interface NotifierMirror {
  entries: Map<string, MirrorEntry>;
  /** epoch ms; null = the snapshot was empty (everything after is new). */
  watermark: number | null;
}

export type NotificationKind = "message" | "new_conversation";

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function unreadOf(row: NotifierConversationRow): number {
  const n = row.unread_count ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Activity newer than everything that existed at start-up. */
export function isFreshActivity(
  row: NotifierConversationRow,
  watermark: number | null,
): boolean {
  if (watermark === null) return true;
  const created = toMs(row.created_at);
  const last = toMs(row.last_message_at);
  return (created !== null && created > watermark) || (last !== null && last > watermark);
}

/**
 * Builds the start-up mirror. Every row here is history by definition:
 * nothing in the snapshot is ever announced, whatever its unread count.
 */
export function buildMirror(rows: readonly NotifierConversationRow[]): NotifierMirror {
  const entries = new Map<string, MirrorEntry>();
  let watermark: number | null = null;
  for (const row of rows) {
    entries.set(row.id, { unread: unreadOf(row), fresh: false, announced: false });
    for (const ts of [toMs(row.created_at), toMs(row.last_message_at)]) {
      if (ts !== null && (watermark === null || ts > watermark)) watermark = ts;
    }
  }
  return { entries, watermark };
}

/**
 * Feeds one realtime INSERT/UPDATE row into the mirror (mutating it) and
 * says whether it is worth an alert. Pure in the sense that matters: the
 * outcome depends only on (mirror, row).
 *
 *  - Known conversation, unread went up → "message".
 *  - Unknown conversation (created after start-up, or it just became
 *    visible — e.g. the Flow routed it into my sector) with fresh
 *    activity and unread > 0 → "new_conversation".
 *  - Fresh conversation first seen with unread 0 (inbound conversations
 *    are INSERTed with 0 and bumped right after) → its first increase is
 *    still announced as "new_conversation".
 *  - Anything else (status flips, assignment changes, reads, agent
 *    sends, old conversations touched by sweeps) → null.
 */
export function applyConversationChange(
  mirror: NotifierMirror,
  row: NotifierConversationRow,
): NotificationKind | null {
  const unread = unreadOf(row);
  const prev = mirror.entries.get(row.id);

  if (!prev) {
    const fresh = isFreshActivity(row, mirror.watermark);
    const entry: MirrorEntry = { unread, fresh, announced: false };
    mirror.entries.set(row.id, entry);
    if (fresh && unread > 0) {
      entry.announced = true;
      return "new_conversation";
    }
    return null;
  }

  const increased = unread > prev.unread;
  prev.unread = unread;
  if (!increased) return null;
  if (prev.fresh && !prev.announced) {
    prev.announced = true;
    return "new_conversation";
  }
  return "message";
}

export function applyConversationDelete(mirror: NotifierMirror, id: string | undefined): void {
  if (id) mirror.entries.delete(id);
}

/**
 * Reconnect catch-up. Compares a fresh snapshot against the mirror,
 * counts conversations that gained inbound activity while realtime was
 * down (only those passing `inScope`), and returns the replacement
 * mirror. The caller fires at most ONE aggregated alert for `count` —
 * never one per missed event.
 */
export function reconcileSnapshot(
  mirror: NotifierMirror,
  rows: readonly NotifierConversationRow[],
  inScope: (row: NotifierConversationRow) => boolean,
): { count: number; mirror: NotifierMirror } {
  const entries = new Map<string, MirrorEntry>();
  let watermark = mirror.watermark;
  let count = 0;

  for (const row of rows) {
    const unread = unreadOf(row);
    const prev = mirror.entries.get(row.id);
    let changed: boolean;
    let entry: MirrorEntry;
    if (prev) {
      changed = unread > prev.unread;
      entry = {
        unread,
        fresh: prev.fresh,
        announced: prev.announced || (changed && prev.fresh),
      };
    } else {
      const fresh = isFreshActivity(row, mirror.watermark);
      changed = fresh && unread > 0;
      entry = { unread, fresh, announced: changed };
    }
    if (changed && inScope(row)) count += 1;
    entries.set(row.id, entry);
  }

  for (const row of rows) {
    for (const ts of [toMs(row.created_at), toMs(row.last_message_at)]) {
      if (ts !== null && (watermark === null || ts > watermark)) watermark = ts;
    }
  }

  return { count, mirror: { entries, watermark } };
}

// ------------------------------------------------------------------
// Scope (on top of RLS)
// ------------------------------------------------------------------

export interface NotifierScope {
  accountId: string;
  userId: string;
  onlyMine: boolean;
  /** queue ids where the user is an ACTIVE member of `accountId`. */
  myQueueIds: ReadonlySet<string>;
}

/**
 * Client-side narrowing on top of RLS. RLS (conversations_select, 083)
 * already decides what reaches this browser; this only (a) pins the
 * active account — a user who belongs to several accounts would
 * otherwise get events from all of them — and (b) applies the optional
 * "only my sectors and assignments" filter.
 */
export function isInNotifierScope(row: NotifierConversationRow, scope: NotifierScope): boolean {
  if (!row.account_id || row.account_id !== scope.accountId) return false;
  if (!scope.onlyMine) return true;
  if (row.assigned_agent_id && row.assigned_agent_id === scope.userId) return true;
  return !!row.queue_id && scope.myQueueIds.has(row.queue_id);
}

// ------------------------------------------------------------------
// "Is the user already looking at it?"
// ------------------------------------------------------------------

export interface ViewerState {
  pathname: string;
  search: string;
  visible: boolean;
  focused: boolean;
}

/**
 * The Inbox keeps the open thread in the URL (`/inbox?c=<id>`,
 * router.replace on select), so a visible + focused tab on that URL is
 * the user reading that conversation.
 */
export function isViewingConversation(state: ViewerState, conversationId: string): boolean {
  if (!state.visible || !state.focused) return false;
  if (state.pathname !== "/inbox") return false;
  return new URLSearchParams(state.search).get("c") === conversationId;
}

export function inboxConversationUrl(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`;
}

// ------------------------------------------------------------------
// Content
// ------------------------------------------------------------------

export interface NotificationCopy {
  messageTitle: string;
  messageBody: string;
  newConversationTitle: string;
  newConversationBody: string;
  /** Fallback when preview is on but the message has no text. */
  previewFallbackBody: string;
}

export interface NotificationContent {
  title: string;
  body: string;
  tag: string;
}

const PREVIEW_MAX_CHARS = 120;

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Builds title/body. With preview OFF (the default) nothing about the
 * customer leaves the app: generic title + generic body. With preview ON
 * the title becomes the contact's name and the body the last message
 * text (trimmed). The tag is per conversation, so a second alert for the
 * same thread replaces the first instead of stacking — and two tabs
 * that somehow both fire collapse into one popup.
 */
export function buildNotificationContent(
  kind: NotificationKind,
  row: NotifierConversationRow,
  options: { showPreview: boolean; contactName: string | null },
  copy: NotificationCopy,
): NotificationContent {
  const tag = `wacrm-conv-${row.id}`;
  const genericTitle = kind === "new_conversation" ? copy.newConversationTitle : copy.messageTitle;
  const genericBody = kind === "new_conversation" ? copy.newConversationBody : copy.messageBody;

  if (!options.showPreview) {
    return { title: genericTitle, body: genericBody, tag };
  }

  const name = options.contactName?.trim();
  const text = row.last_message_text?.trim();
  return {
    title: name ? truncate(name, 60) : genericTitle,
    body: text ? truncate(text, PREVIEW_MAX_CHARS) : copy.previewFallbackBody,
    tag,
  };
}

export const RESYNC_NOTIFICATION_TAG = "wacrm-resync";

/** Per-conversation cooldown so a burst of messages makes one alert. */
export const NOTIFY_COOLDOWN_MS = 4000;

export function isCoolingDown(
  lastShownAt: ReadonlyMap<string, number>,
  conversationId: string,
  now: number,
  cooldownMs = NOTIFY_COOLDOWN_MS,
): boolean {
  const last = lastShownAt.get(conversationId);
  return last !== undefined && now - last < cooldownMs;
}
