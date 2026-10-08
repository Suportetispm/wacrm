"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { NotificationPrefs } from "@/lib/notifications/browser-notify";
import {
  getNotificationPrefs,
  getServerNotificationPrefs,
  setNotificationPrefs,
  subscribeNotificationPrefs,
} from "@/lib/notifications/notification-prefs-store";

/** Browser-scoped notification preferences, live across tabs. */
export function useNotificationPrefs(): [NotificationPrefs, (patch: Partial<NotificationPrefs>) => void] {
  const prefs = useSyncExternalStore(
    subscribeNotificationPrefs,
    getNotificationPrefs,
    getServerNotificationPrefs,
  );
  return [prefs, setNotificationPrefs];
}

export type BrowserNotificationSupport = "supported" | "unsupported" | "insecure";
export type BrowserNotificationPermission = NotificationPermission | "unsupported";

/**
 * The Notification API needs a secure context (HTTPS or localhost) and
 * is missing entirely on some browsers (and iOS outside an installed
 * PWA). Callers must never assume it exists.
 */
export function getBrowserNotificationSupport(): BrowserNotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return "supported";
}

function readPermission(): BrowserNotificationPermission {
  return getBrowserNotificationSupport() === "supported" ? Notification.permission : "unsupported";
}

/**
 * Support + current permission, and a `request` that MUST be called from
 * a click handler (browsers ignore or penalise permission prompts
 * without a user gesture). Re-reads on focus/visibility, on preference
 * changes (the settings panel only flips `enabled` after a grant) and,
 * where available, on the Permissions API change event — users revoke
 * from the browser UI, not from the app.
 *
 * `ready` is false on the server and the first client render, where
 * support/permission read as "unsupported" to keep hydration stable;
 * the effect below syncs to the real values right after mount.
 */
export function useBrowserNotificationPermission(): {
  ready: boolean;
  support: BrowserNotificationSupport;
  permission: BrowserNotificationPermission;
  request: () => Promise<BrowserNotificationPermission>;
} {
  const [state, setState] = useState<{
    ready: boolean;
    support: BrowserNotificationSupport;
    permission: BrowserNotificationPermission;
  }>({ ready: false, support: "unsupported", permission: "unsupported" });

  useEffect(() => {
    const sync = () =>
      setState((prev) => {
        const support = getBrowserNotificationSupport();
        const permission = readPermission();
        return prev.ready && prev.support === support && prev.permission === permission
          ? prev
          : { ready: true, support, permission };
      });
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    const unsubscribePrefs = subscribeNotificationPrefs(sync);

    let status: PermissionStatus | null = null;
    let cancelled = false;
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "notifications" as PermissionName })
        .then((s) => {
          if (cancelled) return;
          status = s;
          s.addEventListener("change", sync);
        })
        .catch(() => {
          // Not queryable on this browser — focus/visibility still cover it.
        });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      unsubscribePrefs();
      status?.removeEventListener("change", sync);
    };
  }, []);

  const request = useCallback(async (): Promise<BrowserNotificationPermission> => {
    if (getBrowserNotificationSupport() !== "supported") return "unsupported";
    let result: NotificationPermission;
    try {
      result = await Notification.requestPermission();
    } catch {
      // Very old Safari only supports the callback form.
      result = await new Promise<NotificationPermission>((resolve) => {
        void Notification.requestPermission(resolve);
      });
    }
    setState({ ready: true, support: "supported", permission: result });
    return result;
  }, []);

  return { ...state, request };
}
