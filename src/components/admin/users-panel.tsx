"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Power, PowerOff, Search, Users as UsersIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { ManagedAccountRole } from "@/lib/platform/users";
import {
  ROLE_LABEL_KEYS,
  buildCreateUserPayload,
  buildUpdateUserPayload,
  buildUsersQueryParams,
  classifyUserApiError,
  emptyUserFormState,
  isUserFormValid,
  queueSelectionOnAccountChange,
  type UserFormState,
  type UsersListFilters,
} from "@/lib/platform/users-ui";

interface AdminAccountOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface AdminUserQueue {
  id: string;
  name: string;
  color: string;
}

interface AdminUser {
  id: string;
  full_name: string;
  email: string;
  account: { id: string; name: string } | null;
  account_role: ManagedAccountRole;
  is_active: boolean;
  queues: AdminUserQueue[];
  created_at: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; user: AdminUser }
  | { kind: "toggle"; user: AdminUser };

/**
 * /admin/users — reuses the same shell/visual pattern as
 * AccountsPanel (src/components/admin/accounts-panel.tsx): a Card
 * with a table (desktop) / cards (mobile), gated server-side by
 * requirePlatformAdmin() in src/app/admin/layout.tsx — this
 * component never re-checks authorization itself, same convention as
 * AccountsPanel.
 *
 * Backend (FASE 6C.3B, already shipped): GET/POST /api/admin/users,
 * GET/PATCH /api/admin/users/[id]. This phase only wires a UI to it.
 */
export function UsersPanel() {
  const t = useTranslations("Admin.users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [accounts, setAccounts] = useState<AdminAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<UsersListFilters>({
    q: "",
    accountId: "",
    role: "all",
    isActive: "all",
  });
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildUsersQueryParams(filters);
      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setUsers((data.users as AdminUser[]) ?? []);
      else toast.error(t("toastLoadFailed"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch("/api/admin/accounts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) =>
        setAccounts(
          (d.accounts as { id: string; name: string; is_active: boolean }[] | undefined)?.map(
            (a) => ({ id: a.id, name: a.name, is_active: a.is_active }),
          ) ?? [],
        ),
      )
      .catch(() => {});
  }, []);

  const activeAccounts = accounts.filter((a) => a.is_active);

  async function submitToggle() {
    if (dialog.kind !== "toggle") return;
    const nextActive = !dialog.user.is_active;
    setToggling(true);
    try {
      const res = await fetch(`/api/admin/users/${dialog.user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: nextActive }),
      });
      if (!res.ok) {
        toast.error(t("toastToggleFailed"));
        return;
      }
      toast.success(nextActive ? t("toastEnabled") : t("toastDisabled"));
      setDialog({ kind: "closed" });
      await load();
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus className="size-4" />
          {t("createButton")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={filters.q}
            onChange={(e) => setFilters((prev) => ({ ...prev, q: e.target.value }))}
            className="w-56 pl-8"
          />
        </div>
        <Select
          value={filters.accountId || "all"}
          onValueChange={(v) =>
            setFilters((prev) => ({ ...prev, accountId: !v || v === "all" ? "" : v }))
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("filterCompanyAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterCompanyAll")}</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.role}
          onValueChange={(v) =>
            setFilters((prev) => ({
              ...prev,
              role: (v ?? "all") as UsersListFilters["role"],
            }))
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("filterRoleAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterRoleAll")}</SelectItem>
            <SelectItem value="admin">{t("roleAdmin")}</SelectItem>
            <SelectItem value="agent">{t("roleAgent")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.isActive}
          onValueChange={(v) =>
            setFilters((prev) => ({
              ...prev,
              isActive: (v ?? "all") as UsersListFilters["isActive"],
            }))
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder={t("filterStatusAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterStatusAll")}</SelectItem>
            <SelectItem value="true">{t("active")}</SelectItem>
            <SelectItem value="false">{t("inactive")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <UsersIcon className="size-4 text-primary" />
            {t("listTitle")}
          </CardTitle>
          <CardDescription>{t("listDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : users.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colName")}</TableHead>
                      <TableHead>{t("colEmail")}</TableHead>
                      <TableHead>{t("colCompany")}</TableHead>
                      <TableHead>{t("colRole")}</TableHead>
                      <TableHead>{t("colQueues")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead className="text-right">{t("colActions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium text-foreground">
                          {row.full_name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{row.email}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.account?.name ?? "—"}
                        </TableCell>
                        <TableCell>{t(ROLE_LABEL_KEYS[row.account_role])}</TableCell>
                        <TableCell>
                          <QueuesCell queues={row.queues} emptyLabel={t("noQueues")} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            active={row.is_active}
                            labelActive={t("active")}
                            labelInactive={t("inactive")}
                          />
                        </TableCell>
                        <TableCell>
                          <RowActions
                            row={row}
                            t={t}
                            onEdit={() => setDialog({ kind: "edit", user: row })}
                            onToggle={() => setDialog({ kind: "toggle", user: row })}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-col gap-3 md:hidden">
                {users.map((row) => (
                  <div key={row.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{row.full_name}</p>
                        <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.account?.name ?? "—"} · {t(ROLE_LABEL_KEYS[row.account_role])}
                        </p>
                        <div className="mt-1">
                          <QueuesCell queues={row.queues} emptyLabel={t("noQueues")} />
                        </div>
                      </div>
                      <StatusBadge
                        active={row.is_active}
                        labelActive={t("active")}
                        labelInactive={t("inactive")}
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <RowActions
                        row={row}
                        t={t}
                        onEdit={() => setDialog({ kind: "edit", user: row })}
                        onToggle={() => setDialog({ kind: "toggle", user: row })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <UserFormDialog
        mode="create"
        open={dialog.kind === "create"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
        accounts={activeAccounts}
        initialUser={null}
        onSaved={load}
      />

      <UserFormDialog
        mode="edit"
        open={dialog.kind === "edit"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
        accounts={activeAccounts}
        initialUser={dialog.kind === "edit" ? dialog.user : null}
        onSaved={load}
      />

      <Dialog
        open={dialog.kind === "toggle"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
      >
        <DialogContent>
          {dialog.kind === "toggle" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.user.is_active ? t("disableTitle") : t("enableTitle")}
                </DialogTitle>
                <DialogDescription>
                  {dialog.user.is_active
                    ? t("disableDesc", { name: dialog.user.full_name })
                    : t("enableDesc", { name: dialog.user.full_name })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDialog({ kind: "closed" })}
                  disabled={toggling}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={dialog.user.is_active ? "destructive" : "default"}
                  onClick={submitToggle}
                  disabled={toggling}
                >
                  {toggling ? <Loader2 className="size-4 animate-spin" /> : null}
                  {dialog.user.is_active ? t("disableConfirm") : t("enableConfirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QueuesCell({
  queues,
  emptyLabel,
}: {
  queues: AdminUserQueue[];
  emptyLabel: string;
}) {
  if (queues.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {queues.map((q) => (
        <span
          key={q.id}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
        >
          <span className="size-1.5 rounded-full" style={{ backgroundColor: q.color }} />
          {q.name}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({
  active,
  labelActive,
  labelInactive,
}: {
  active: boolean;
  labelActive: string;
  labelInactive: string;
}) {
  return (
    <Badge variant={active ? "secondary" : "destructive"}>
      {active ? labelActive : labelInactive}
    </Badge>
  );
}

function RowActions({
  row,
  t,
  onEdit,
  onToggle,
}: {
  row: AdminUser;
  t: ReturnType<typeof useTranslations>;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit}>
        {t("edit")}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggle}
        aria-label={row.is_active ? t("deactivate") : t("activate")}
        title={row.is_active ? t("deactivate") : t("activate")}
      >
        {row.is_active ? <PowerOff className="size-4" /> : <Power className="size-4" />}
      </Button>
    </div>
  );
}

function UserFormDialog({
  mode,
  open,
  onOpenChange,
  accounts,
  initialUser,
  onSaved,
}: {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active-only companies — only relevant for `mode: "create"`. */
  accounts: AdminAccountOption[];
  initialUser: AdminUser | null;
  onSaved: () => void;
}) {
  const t = useTranslations("Admin.users");
  const [form, setForm] = useState<UserFormState>(emptyUserFormState());
  const [queues, setQueues] = useState<AdminUserQueue[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && initialUser) {
      setForm({
        fullName: initialUser.full_name,
        email: initialUser.email,
        password: "",
        accountId: initialUser.account?.id ?? "",
        role: initialUser.account_role,
        queueIds: initialUser.queues.map((q) => q.id),
        isActive: initialUser.is_active,
      });
    } else {
      setForm(emptyUserFormState());
    }
  }, [open, mode, initialUser]);

  useEffect(() => {
    if (!open || !form.accountId) {
      setQueues([]);
      return;
    }
    let cancelled = false;
    setQueuesLoading(true);
    fetch(`/api/admin/accounts/${form.accountId}/queues`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setQueues((d.queues as AdminUserQueue[]) ?? []);
      })
      .catch(() => {
        if (!cancelled) toast.error(t("toastQueuesLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setQueuesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.accountId]);

  function handleAccountChange(nextAccountId: string) {
    setForm((prev) => ({
      ...prev,
      accountId: nextAccountId,
      queueIds: queueSelectionOnAccountChange(prev.accountId, nextAccountId, prev.queueIds),
    }));
  }

  function toggleQueue(queueId: string, checked: boolean) {
    setForm((prev) => ({
      ...prev,
      queueIds: checked
        ? [...prev.queueIds, queueId]
        : prev.queueIds.filter((id) => id !== queueId),
    }));
  }

  async function submit() {
    setSaving(true);
    try {
      const res =
        mode === "create"
          ? await fetch("/api/admin/users", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(buildCreateUserPayload(form)),
            })
          : await fetch(`/api/admin/users/${initialUser?.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(buildUpdateUserPayload(form)),
            });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const info = classifyUserApiError(res.status, body);
        const message = info.translatedKey
          ? t(info.translatedKey)
          : (info.detail ?? t("errorGeneric"));
        toast.error(
          t(mode === "create" ? "toastCreateFailed" : "toastUpdateFailed", { message }),
        );
        return;
      }

      toast.success(t(mode === "create" ? "toastCreated" : "toastUpdated"));
      // Never let the password linger in state past a successful
      // create, even momentarily — reset before closing.
      setForm(emptyUserFormState());
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setForm(emptyUserFormState());
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? t("createTitle") : t("editTitle")}</DialogTitle>
          <DialogDescription>
            {mode === "create" ? t("createDesc") : t("editDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="user-full-name">{t("fieldFullName")}</Label>
            <Input
              id="user-full-name"
              value={form.fullName}
              onChange={(e) => setForm((prev) => ({ ...prev, fullName: e.target.value }))}
              maxLength={120}
              disabled={saving}
            />
          </div>

          {mode === "create" ? (
            <div className="space-y-2">
              <Label htmlFor="user-email">{t("fieldEmail")}</Label>
              <Input
                id="user-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                disabled={saving}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t("readOnlyEmail")}</Label>
              <p className="text-sm text-foreground">{initialUser?.email}</p>
            </div>
          )}

          {mode === "create" && (
            <div className="space-y-2">
              <Label htmlFor="user-password">{t("fieldPassword")}</Label>
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
            </div>
          )}

          {mode === "create" ? (
            <div className="space-y-2">
              <Label>{t("fieldCompany")}</Label>
              <Select
                value={form.accountId || undefined}
                onValueChange={(v) => v && handleAccountChange(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("companyPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t("readOnlyCompany")}</Label>
              <p className="text-sm text-foreground">{initialUser?.account?.name ?? "—"}</p>
            </div>
          )}

          <div className="space-y-2">
            <Label>{t("fieldRole")}</Label>
            <Select
              value={form.role}
              onValueChange={(v) =>
                v && setForm((prev) => ({ ...prev, role: v as ManagedAccountRole }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{t("roleAdmin")}</SelectItem>
                <SelectItem value="agent">{t("roleAgent")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("fieldQueues")}</Label>
            {!form.accountId ? (
              <p className="text-xs text-muted-foreground">{t("companyPlaceholder")}</p>
            ) : queuesLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("loading")}
              </div>
            ) : queues.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("queuesEmpty")}</p>
            ) : (
              <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border p-2">
                {queues.map((q) => (
                  <label key={q.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.queueIds.includes(q.id)}
                      onCheckedChange={(checked) => toggleQueue(q.id, checked === true)}
                    />
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: q.color }}
                      />
                      {q.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {form.accountId && !queuesLoading && form.queueIds.length === 0 && queues.length > 0 && (
              <p className="text-xs text-muted-foreground">{t("queuesNone")}</p>
            )}
          </div>

          {mode === "edit" && (
            <div className="flex items-center justify-between">
              <Label htmlFor="user-active">{t("fieldActive")}</Label>
              <Switch
                id="user-active"
                checked={form.isActive}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, isActive: checked }))
                }
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={saving || !isUserFormValid(mode, form)}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode === "create" ? t("createSubmit") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
