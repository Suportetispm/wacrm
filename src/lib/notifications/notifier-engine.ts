import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import {
  NOTIFIER_SNAPSHOT_COLUMNS,
  applyConversationChange,
  applyConversationDelete,
  buildMirror,
  isInNotifierScope,
  reconcileSnapshot,
  type NotificationKind,
  type NotifierConversationRow,
  type NotifierMirror,
  type NotifierScope,
} from "./browser-notify";

/**
 * Realtime side of the browser notifier. Runs only in the leader tab
 * (see tab-coordination.ts). Read-only: one SELECT snapshot of the
 * visible conversations, one SELECT of the user's active sectors, one
 * `postgres_changes` subscription on `conversations` — never writes.
 *
 * Isolation is RLS-first: the subscription goes through the shared
 * browser client with the user's JWT, so Supabase Realtime evaluates
 * conversations_select (083) per event — other accounts and, in
 * sector-mode accounts, other sectors never reach this tab. The
 * `account_id=eq.<active account>` filter and `isInNotifierScope` only
 * narrow further.
 */

/** Newest N conversations are enough: older ones are never "fresh". */
const SNAPSHOT_LIMIT = 1000;
const SNAPSHOT_RETRY_MS = 15_000;

export interface NotifierEngineOptions {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  /** Read at decision time so toggles apply without a restart. */
  getOnlyMine: () => boolean;
  onAlert: (alert: NotifierAlert) => void;
}

export type NotifierAlert =
  | { kind: NotificationKind; row: NotifierConversationRow }
  | { kind: "resync"; count: number };

export function startNotifierEngine(options: NotifierEngineOptions): () => void {
  const { supabase, accountId, userId, getOnlyMine, onAlert } = options;

  let stopped = false;
  let mirror: NotifierMirror | null = null;
  let myQueueIds: ReadonlySet<string> = new Set();
  let hasSubscribedOnce = false;
  let snapshotInFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scope = (): NotifierScope => ({
    accountId,
    userId,
    onlyMine: getOnlyMine(),
    myQueueIds,
  });

  async function loadQueues(): Promise<void> {
    const { data, error } = await supabase
      .from("queue_members")
      .select("queue_id")
      .eq("user_id", userId)
      .eq("account_id", accountId)
      .eq("is_active", true);
    if (stopped || error || !data) return;
    myQueueIds = new Set((data as { queue_id: string | null }[]).flatMap((r) => (r.queue_id ? [r.queue_id] : [])));
  }

  async function loadSnapshot(): Promise<NotifierConversationRow[] | null> {
    const { data, error } = await supabase
      .from("conversations")
      .select(NOTIFIER_SNAPSHOT_COLUMNS)
      .eq("account_id", accountId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(SNAPSHOT_LIMIT);
    if (error || !data) return null;
    return data as NotifierConversationRow[];
  }

  /**
   * `mode`:
   *  - "init"    → first snapshot, never alerts.
   *  - "resync"  → after a realtime reconnect; at most one aggregated alert.
   *  - "silent"  → tab came back to the foreground; refresh state only.
   */
  async function refresh(mode: "init" | "resync" | "silent"): Promise<void> {
    if (snapshotInFlight || stopped) return;
    snapshotInFlight = true;
    try {
      await loadQueues();
      const rows = await loadSnapshot();
      if (stopped) return;
      if (!rows) {
        if (!mirror) scheduleRetry();
        return;
      }
      if (!mirror) {
        mirror = buildMirror(rows);
        return;
      }
      const s = scope();
      const { count, mirror: next } = reconcileSnapshot(mirror, rows, (row) =>
        isInNotifierScope(row, s),
      );
      mirror = next;
      if (mode === "resync" && count > 0) onAlert({ kind: "resync", count });
    } catch (err) {
      console.error("[browser-notifier] snapshot failed:", err instanceof Error ? err.message : err);
      if (!mirror) scheduleRetry();
    } finally {
      snapshotInFlight = false;
    }
  }

  function scheduleRetry() {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void refresh("init");
    }, SNAPSHOT_RETRY_MS);
  }

  // Unique topic per run: realtime-js only drops a channel from its list
  // after the server acks the leave, and `channel(sameTopic)` returns
  // that still-leaving instance — adding `.on()` to it would throw. A
  // fresh suffix makes a quick stop/start (leader hand-off, StrictMode
  // remount in dev) always get a new channel.
  const topicSuffix = Math.random().toString(36).slice(2, 10);
  const channel: RealtimeChannel = supabase
    .channel(`browser-notifier:${accountId}:${topicSuffix}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "conversations", filter: `account_id=eq.${accountId}` },
      (payload) => {
        // Events that land before the start-up snapshot are dropped: the
        // snapshot (taken after SUBSCRIBED) already reflects them, and
        // treating them as news would alert on history.
        if (stopped || !mirror) return;
        if (payload.eventType === "DELETE") {
          applyConversationDelete(mirror, (payload.old as Partial<NotifierConversationRow>)?.id);
          return;
        }
        const row = payload.new as NotifierConversationRow;
        if (!row?.id || row.account_id !== accountId) return;
        const kind = applyConversationChange(mirror, row);
        if (kind && isInNotifierScope(row, scope())) onAlert({ kind, row });
      },
    )
    .subscribe((status) => {
      if (stopped || status !== "SUBSCRIBED") return;
      if (!hasSubscribedOnce) {
        hasSubscribedOnce = true;
        void refresh("init");
      } else {
        // Rejoined after a drop: events in the gap are lost, catch up
        // with one aggregated alert instead of replaying them.
        void refresh(mirror ? "resync" : "init");
      }
    });

  const onVisibility = () => {
    if (document.visibilityState === "visible") void refresh(mirror ? "silent" : "init");
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    void supabase.removeChannel(channel);
  };
}
