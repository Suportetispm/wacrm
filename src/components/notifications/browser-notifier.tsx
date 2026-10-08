"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import {
  useBrowserNotificationPermission,
  useNotificationPrefs,
} from "@/hooks/use-notification-prefs";
import { createClient } from "@/lib/supabase/client";
import {
  RESYNC_NOTIFICATION_TAG,
  buildNotificationContent,
  inboxConversationUrl,
  isCoolingDown,
  isViewingConversation,
  resolveOnlyMine,
  type NotificationCopy,
} from "@/lib/notifications/browser-notify";
import { startNotifierEngine, type NotifierAlert } from "@/lib/notifications/notifier-engine";
import {
  installNotificationSoundUnlock,
  playNotificationSound,
} from "@/lib/notifications/notification-sound";
import { createViewingCoordinator, runAsLeader } from "@/lib/notifications/tab-coordination";

/**
 * BrowserNotifier — headless, mounted once per dashboard tab (next to
 * PresenceHeartbeat). Fires native browser notifications for new
 * inbound messages / new conversations while the app is open, including
 * in a background tab or minimised window. No Web Push: with every tab
 * closed nothing fires.
 *
 * Off unless ALL of: the browser supports the API in a secure context,
 * the user enabled it in Settings → Notifications (default off), and the
 * browser permission is "granted". Never asks for permission itself —
 * that only happens from an explicit click in the settings panel.
 */
export function BrowserNotifier() {
  const { user, accountId, accountRole } = useAuth();
  const [prefs] = useNotificationPrefs();
  const { support, permission } = useBrowserNotificationPermission();
  const router = useRouter();
  const t = useTranslations("BrowserNotifier");

  const userId = user?.id ?? null;
  const active =
    prefs.enabled &&
    support === "supported" &&
    permission === "granted" &&
    !!userId &&
    !!accountId;

  // Latest values for async callbacks, assigned in an effect (React 19
  // refs rule) — the engine reads them at decision time, so toggling
  // sound / preview / "only mine" applies without restarting it.
  const prefsRef = useRef(prefs);
  const roleRef = useRef(accountRole);
  const routerRef = useRef(router);
  const tRef = useRef(t);
  useEffect(() => {
    prefsRef.current = prefs;
    roleRef.current = accountRole;
    routerRef.current = router;
    tRef.current = t;
  });

  // Audio can only start after a user gesture; arm a one-shot unlock.
  useEffect(() => {
    if (!active || !prefs.sound) return;
    return installNotificationSoundUnlock();
  }, [active, prefs.sound]);

  useEffect(() => {
    if (!active || !userId || !accountId) return;

    const supabase = createClient();
    const lastShownAt = new Map<string, number>();

    const isViewingLocally = (conversationId: string) =>
      isViewingConversation(
        {
          pathname: window.location.pathname,
          search: window.location.search,
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
        },
        conversationId,
      );

    // Every active tab answers "are you showing conversation X?";
    // only the leader asks.
    const coordinator = createViewingCoordinator(isViewingLocally);

    const navigate = (url: string) => {
      // In the Inbox already: switch thread in place. Anywhere else, open
      // a new tab so unsaved work on the current page (Flow editor,
      // forms) is never navigated away from.
      if (window.location.pathname === "/inbox") {
        routerRef.current.push(url);
        return;
      }
      const opened = window.open(url, "_blank");
      if (!opened) routerRef.current.push(url);
    };

    const show = (
      content: { title: string; body: string; tag: string },
      url: string,
    ) => {
      const current = prefsRef.current;
      if (!current.enabled || Notification.permission !== "granted") return;

      // Our own beep when audio is unlocked; otherwise let the OS play
      // its notification sound. Sound off → fully silent.
      const beeped = current.sound ? playNotificationSound() : false;
      const options: NotificationOptions & { renotify?: boolean } = {
        body: content.body,
        tag: content.tag,
        icon: "/icon",
        silent: !current.sound || beeped,
        renotify: true,
      };

      let notification: Notification;
      try {
        notification = new Notification(content.title, options);
      } catch {
        // e.g. Android Chrome: page-constructed notifications throw
        // (service-worker only). Nothing to show — fail quietly.
        return;
      }
      notification.onclick = (event) => {
        event.preventDefault();
        notification.close();
        window.focus();
        navigate(url);
      };
    };

    const copy = (): NotificationCopy => ({
      messageTitle: tRef.current("messageTitle"),
      messageBody: tRef.current("messageBody"),
      newConversationTitle: tRef.current("newConversationTitle"),
      newConversationBody: tRef.current("newConversationBody"),
      previewFallbackBody: tRef.current("previewFallbackBody"),
    });

    const onAlert = async (alert: NotifierAlert) => {
      if (alert.kind === "resync") {
        show(
          {
            title: tRef.current("resyncTitle"),
            body: tRef.current("resyncBody", { count: alert.count }),
            tag: RESYNC_NOTIFICATION_TAG,
          },
          "/inbox",
        );
        return;
      }

      const { row } = alert;
      const now = Date.now();
      if (isCoolingDown(lastShownAt, row.id, now)) return;
      if (await coordinator.isViewedAnywhere(row.id)) return;

      const showPreview = prefsRef.current.showPreview;
      let contactName: string | null = null;
      if (showPreview && row.contact_id) {
        // RLS-scoped read of the one contact; only when preview is on.
        const { data } = await supabase
          .from("contacts")
          .select("name, phone")
          .eq("id", row.contact_id)
          .maybeSingle();
        const contact = data as { name: string | null; phone: string | null } | null;
        contactName = contact?.name?.trim() || contact?.phone || null;
      }

      lastShownAt.set(row.id, Date.now());
      show(
        buildNotificationContent(alert.kind, row, { showPreview, contactName }, copy()),
        inboxConversationUrl(row.id),
      );
    };

    const disposeLeadership = runAsLeader(
      `wacrm:browser-notifier:${userId}:${accountId}`,
      () =>
        startNotifierEngine({
          supabase,
          accountId,
          userId,
          getOnlyMine: () => resolveOnlyMine(prefsRef.current, roleRef.current),
          onAlert: (alert) => {
            void onAlert(alert).catch((err) => {
              console.error(
                "[browser-notifier] alert failed:",
                err instanceof Error ? err.message : err,
              );
            });
          },
        }),
    );

    return () => {
      disposeLeadership();
      coordinator.close();
    };
  }, [active, userId, accountId]);

  return null;
}
