"use client";

import type { ReactNode } from "react";
import { BellRing, Info, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import {
  useBrowserNotificationPermission,
  useNotificationPrefs,
  type BrowserNotificationPermission,
  type BrowserNotificationSupport,
} from "@/hooks/use-notification-prefs";
import { defaultOnlyMineForRole, resolveOnlyMine } from "@/lib/notifications/browser-notify";
import {
  playNotificationSound,
  unlockNotificationSound,
} from "@/lib/notifications/notification-sound";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Settings → Notifications. Browser-scoped preferences for native
 * notifications (see components/notifications/browser-notifier.tsx).
 * Every change applies immediately and persists in this browser only.
 * The permission prompt is only ever triggered from a click here.
 */
export function NotificationsPanel() {
  const t = useTranslations("Settings.notifications");
  const { accountRole } = useAuth();
  const [prefs, setPrefs] = useNotificationPrefs();
  const { ready, support, permission, request } = useBrowserNotificationPermission();

  const granted = permission === "granted";
  const onlyMine = resolveOnlyMine(prefs, accountRole);
  const roleDefaultOnlyMine = defaultOnlyMineForRole(accountRole);

  const handleEnabledChange = async (checked: boolean) => {
    if (!checked) {
      setPrefs({ enabled: false });
      return;
    }
    // `request()` runs first, inside the click — browsers require a
    // user gesture for the permission prompt.
    const result = granted ? "granted" : await request();
    if (result === "granted") {
      setPrefs({ enabled: true });
    } else if (result === "denied") {
      toast.error(t("permissionDeniedToast"));
    }
  };

  const handleSoundChange = (checked: boolean) => {
    if (checked) {
      // The toggle click is a gesture: unlock audio and play a sample.
      unlockNotificationSound();
      window.setTimeout(() => playNotificationSound(), 60);
    }
    setPrefs({ sound: checked });
  };

  const sendTest = () => {
    if (!granted) return;
    let beeped = false;
    if (prefs.sound) {
      unlockNotificationSound();
      beeped = playNotificationSound();
    }
    try {
      const n = new Notification(t("testTitle"), {
        body: t("testBody"),
        tag: "wacrm-test",
        icon: "/icon",
        silent: !prefs.sound || beeped,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      toast.error(t("testFailed"));
    }
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {/* Rendered only after mount: support/permission are browser-only,
          reading them during SSR would mismatch on hydration. */}
      {ready ? (
        <StatusBanner
          support={support}
          permission={permission}
          onRequest={() => void request()}
        />
      ) : null}

      <div className="mt-5 divide-y divide-border rounded-xl border border-border bg-card">
        <SettingRow
          title={t("enabledLabel")}
          description={t("enabledHint")}
          control={
            <Switch
              checked={prefs.enabled && granted}
              onCheckedChange={(checked) => void handleEnabledChange(checked)}
              disabled={!ready || support !== "supported" || permission === "denied"}
              aria-label={t("enabledLabel")}
            />
          }
        />
        <SettingRow
          title={t("soundLabel")}
          description={t("soundHint")}
          control={
            <Switch
              checked={prefs.sound}
              onCheckedChange={handleSoundChange}
              disabled={!prefs.enabled}
              aria-label={t("soundLabel")}
            />
          }
        />
        <SettingRow
          title={t("previewLabel")}
          description={t("previewHint")}
          control={
            <Switch
              checked={prefs.showPreview}
              onCheckedChange={(checked) => setPrefs({ showPreview: checked })}
              disabled={!prefs.enabled}
              aria-label={t("previewLabel")}
            />
          }
        />
        <SettingRow
          title={t("onlyMineLabel")}
          description={
            <>
              {t("onlyMineHint")}{" "}
              {prefs.onlyMine === null
                ? roleDefaultOnlyMine
                  ? t("onlyMineDefaultOn")
                  : t("onlyMineDefaultOff")
                : null}
            </>
          }
          control={
            <Switch
              checked={onlyMine}
              onCheckedChange={(checked) => setPrefs({ onlyMine: checked })}
              disabled={!prefs.enabled}
              aria-label={t("onlyMineLabel")}
            />
          }
        />
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {t("scopeNote")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={sendTest}
          disabled={!granted}
        >
          <BellRing />
          {t("testButton")}
        </Button>
      </div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function StatusBanner({
  support,
  permission,
  onRequest,
}: {
  support: BrowserNotificationSupport;
  permission: BrowserNotificationPermission;
  onRequest: () => void;
}) {
  const t = useTranslations("Settings.notifications");

  let tone: "warn" | "info" | "ok";
  let message: string;
  let action: ReactNode = null;

  if (support === "unsupported") {
    tone = "warn";
    message = t("statusUnsupported");
  } else if (support === "insecure") {
    tone = "warn";
    message = t("statusInsecure");
  } else if (permission === "denied") {
    tone = "warn";
    message = t("statusDenied");
  } else if (permission === "granted") {
    tone = "ok";
    message = t("statusGranted");
  } else {
    tone = "info";
    message = t("statusDefault");
    action = (
      <Button type="button" size="sm" onClick={onRequest}>
        {t("requestButton")}
      </Button>
    );
  }

  return (
    <div
      className={
        tone === "warn"
          ? "flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
          : tone === "ok"
            ? "flex flex-col gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
            : "flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"
      }
      role="status"
    >
      <p className="flex items-start gap-2 text-sm text-foreground">
        {tone === "warn" ? (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
        ) : (
          <BellRing className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        {message}
      </p>
      {action}
    </div>
  );
}
