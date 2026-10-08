import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_PREFS_STORAGE_KEY,
  parseNotificationPrefs,
  serializeNotificationPrefs,
  type NotificationPrefs,
} from "./browser-notify";

/**
 * Browser-scoped store for notification preferences (localStorage, like
 * the theme prefs — the browser permission is per browser anyway, so a
 * DB column would only add a way to be out of sync). Shaped for
 * `useSyncExternalStore`: same-tab writes dispatch a custom event, other
 * tabs pick changes up through the native `storage` event.
 */

const CHANGE_EVENT = "wacrm:notification-prefs";

let cachedRaw: string | null | undefined;
let cachedPrefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(NOTIFICATION_PREFS_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage — behave as "never configured".
    return null;
  }
}

/** Stable reference while the stored string is unchanged. */
export function getNotificationPrefs(): NotificationPrefs {
  if (typeof window === "undefined") return DEFAULT_NOTIFICATION_PREFS;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = parseNotificationPrefs(raw);
  }
  return cachedPrefs;
}

export function getServerNotificationPrefs(): NotificationPrefs {
  return DEFAULT_NOTIFICATION_PREFS;
}

export function setNotificationPrefs(patch: Partial<NotificationPrefs>): void {
  const next = { ...getNotificationPrefs(), ...patch };
  try {
    window.localStorage.setItem(NOTIFICATION_PREFS_STORAGE_KEY, serializeNotificationPrefs(next));
  } catch {
    // Storage blocked (private mode, sandbox): nothing persists, and the
    // notifier stays on the defaults — i.e. off. Fail closed.
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeNotificationPrefs(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === NOTIFICATION_PREFS_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
