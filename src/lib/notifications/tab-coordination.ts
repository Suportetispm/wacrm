/**
 * Cross-tab coordination for browser notifications.
 *
 * 1. Leader election (Web Locks — Chrome/Edge 69+, Firefox 96+, Safari
 *    15.4+): only the tab holding the lock subscribes to realtime and
 *    shows notifications, so N open tabs produce one alert, one sound
 *    and one realtime subscription. Closing the leader releases the lock
 *    and the next tab takes over automatically. Without Web Locks every
 *    tab leads; the per-conversation notification `tag` still collapses
 *    duplicate popups at the OS level (sound may repeat).
 *
 * 2. "Is any tab showing this conversation?" (BroadcastChannel): the
 *    leader may be a background tab while the user reads the thread in
 *    another one. Before alerting, the leader asks; any tab currently
 *    viewing that conversation answers within a short window.
 */

export const NOTIFIER_CHANNEL_NAME = "wacrm:browser-notifier";
const VIEWING_QUERY_TIMEOUT_MS = 150;

type CoordinationMessage =
  | { type: "query"; queryId: string; conversationId: string }
  | { type: "viewing"; queryId: string };

interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void> | void,
  ): Promise<unknown>;
}

function getLockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Runs `onLeader` while this tab holds `lockName`. `onLeader` returns
 * its own cleanup, called when this tab stops leading (unmount, or the
 * returned dispose). Returns a dispose for the whole election.
 */
export function runAsLeader(lockName: string, onLeader: () => () => void): () => void {
  const locks = getLockManager();
  if (!locks) {
    const stop = onLeader();
    return stop;
  }

  const abort = new AbortController();
  let disposed = false;
  let stopLeader: (() => void) | null = null;
  let releaseLock: (() => void) | null = null;

  locks
    .request(lockName, { signal: abort.signal }, () => {
      if (disposed) return;
      stopLeader = onLeader();
      // Hold the lock until dispose resolves this promise.
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    })
    .catch(() => {
      // AbortError when disposed while still waiting — expected.
    });

  return () => {
    disposed = true;
    abort.abort();
    stopLeader?.();
    stopLeader = null;
    releaseLock?.();
    releaseLock = null;
  };
}

export interface ViewingCoordinator {
  /** True if this tab or any other tab is showing the conversation. */
  isViewedAnywhere(conversationId: string): Promise<boolean>;
  close(): void;
}

/**
 * Every active tab runs one coordinator (as a responder); the leader also
 * uses it to ask. `isViewingLocally` is evaluated at question time, so it
 * always reflects the tab's current URL / visibility / focus.
 */
export function createViewingCoordinator(
  isViewingLocally: (conversationId: string) => boolean,
): ViewingCoordinator {
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(NOTIFIER_CHANNEL_NAME) : null;
  const pending = new Map<string, (viewing: boolean) => void>();

  if (channel) {
    channel.onmessage = (event: MessageEvent<CoordinationMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "query") {
        if (isViewingLocally(msg.conversationId)) {
          channel.postMessage({ type: "viewing", queryId: msg.queryId } satisfies CoordinationMessage);
        }
      } else if (msg.type === "viewing") {
        pending.get(msg.queryId)?.(true);
      }
    };
  }

  return {
    isViewedAnywhere(conversationId) {
      if (isViewingLocally(conversationId)) return Promise.resolve(true);
      if (!channel) return Promise.resolve(false);
      const queryId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return new Promise<boolean>((resolve) => {
        const finish = (viewing: boolean) => {
          clearTimeout(timer);
          pending.delete(queryId);
          resolve(viewing);
        };
        const timer = setTimeout(() => finish(false), VIEWING_QUERY_TIMEOUT_MS);
        pending.set(queryId, finish);
        channel.postMessage({ type: "query", queryId, conversationId } satisfies CoordinationMessage);
      });
    },
    close() {
      for (const finish of pending.values()) finish(false);
      pending.clear();
      channel?.close();
    },
  };
}
