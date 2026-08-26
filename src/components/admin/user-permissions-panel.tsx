"use client";

// ============================================================
// Seção "Permissões" dentro do editor de usuário do Superadmin.
// Só é renderizada pelo chamador (UserFormDialog, users-panel.tsx)
// quando `initialUser.account_role JÁ SALVO === 'agent'` — nunca a
// partir do valor ainda não salvo do dropdown de role (ver seção 6 do
// retorno da FASE 1). owner/admin/viewer nunca têm overrides nesta
// fase, então este componente nunca é montado para eles.
//
// Cada permissão tem três estados — Herdar | Permitir | Bloquear —
// espelhando 1:1 `allowed IS NULL (ausência de linha) | true | false`
// em user_permission_overrides (062_user_permission_overrides.sql).
// "Herdar" mostra entre parênteses o resultado efetivo do default do
// agent, para o Superadmin nunca precisar adivinhar o que "herdar"
// significa na prática.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PERMISSION_KEYS, type PermissionKey } from "@/lib/auth/permissions";

type OverrideState = "inherit" | "allow" | "deny";

interface PermissionGroup {
  groupLabelKey: string;
  keys: { key: PermissionKey; labelKey: string }[];
}

const GROUPS: PermissionGroup[] = [
  {
    groupLabelKey: "groupUsers",
    keys: [
      { key: "users.view", labelKey: "keyUsersView" },
      { key: "users.create", labelKey: "keyUsersCreate" },
      { key: "users.edit", labelKey: "keyUsersEdit" },
    ],
  },
  {
    groupLabelKey: "groupQueues",
    keys: [
      { key: "queues.view", labelKey: "keyQueuesView" },
      { key: "queues.manage", labelKey: "keyQueuesManage" },
    ],
  },
  {
    groupLabelKey: "groupFlows",
    keys: [
      { key: "flows.view", labelKey: "keyFlowsView" },
      { key: "flows.manage", labelKey: "keyFlowsManage" },
      { key: "flows.activate", labelKey: "keyFlowsActivate" },
    ],
  },
  {
    groupLabelKey: "groupAutomations",
    keys: [
      { key: "automations.view", labelKey: "keyAutomationsView" },
      { key: "automations.manage", labelKey: "keyAutomationsManage" },
    ],
  },
  {
    groupLabelKey: "groupQuickReplies",
    keys: [
      { key: "quick_replies.view", labelKey: "keyQuickRepliesView" },
      { key: "quick_replies.manage", labelKey: "keyQuickRepliesManage" },
    ],
  },
];

function emptyValues(): Record<PermissionKey, OverrideState> {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, "inherit"])) as Record<
    PermissionKey,
    OverrideState
  >;
}

interface PermissionsApiResponse {
  applicable: boolean;
  overrides?: Partial<Record<PermissionKey, boolean>>;
  effective?: Record<PermissionKey, boolean>;
}

export function UserPermissionsPanel({ userId }: { userId: string }) {
  const t = useTranslations("Admin.users.permissions");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [effective, setEffective] = useState<Record<PermissionKey, boolean> | null>(null);
  const [values, setValues] = useState<Record<PermissionKey, OverrideState>>(emptyValues());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/permissions`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as PermissionsApiResponse | null;
      if (!res.ok || !data) {
        toast.error(t("loadFailed"));
        return;
      }
      setEffective(data.effective ?? null);
      const next = emptyValues();
      for (const key of PERMISSION_KEYS) {
        const allowed = data.overrides?.[key];
        next[key] = allowed === true ? "allow" : allowed === false ? "deny" : "inherit";
      }
      setValues(next);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const overrides: Partial<Record<PermissionKey, boolean | null>> = {};
      for (const key of PERMISSION_KEYS) {
        overrides[key] = values[key] === "allow" ? true : values[key] === "deny" ? false : null;
      }
      const res = await fetch(`/api/admin/users/${userId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      const data = (await res.json().catch(() => null)) as PermissionsApiResponse | null;
      if (!res.ok || !data) {
        toast.error(t("saveFailed"));
        return;
      }
      setEffective(data.effective ?? null);
      toast.success(t("saved"));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setResetting(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/permissions/reset`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as PermissionsApiResponse | null;
      if (!res.ok || !data) {
        toast.error(t("resetFailed"));
        return;
      }
      setEffective(data.effective ?? null);
      setValues(emptyValues());
      toast.success(t("resetDone"));
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">{t("sectionTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("sectionDesc")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={resetting || saving}>
          {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          {t("reset")}
        </Button>
      </div>

      <div className="space-y-4">
        {GROUPS.map((group) => (
          <div key={group.groupLabelKey} className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t(group.groupLabelKey)}
            </p>
            <div className="space-y-1.5">
              {group.keys.map(({ key, labelKey }) => {
                const inheritLabel = effective?.[key]
                  ? t("inheritEffectiveAllowed")
                  : t("inheritEffectiveDenied");
                return (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">{t(labelKey)}</span>
                    <Select
                      items={[
                        { value: "inherit", label: inheritLabel },
                        { value: "allow", label: t("stateAllow") },
                        { value: "deny", label: t("stateDeny") },
                      ]}
                      value={values[key]}
                      onValueChange={(v) =>
                        v &&
                        setValues((prev) => ({ ...prev, [key]: v as OverrideState }))
                      }
                    >
                      <SelectTrigger className="w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">{inheritLabel}</SelectItem>
                        <SelectItem value="allow">{t("stateAllow")}</SelectItem>
                        <SelectItem value="deny">{t("stateDeny")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving || resetting}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </div>
    </div>
  );
}
