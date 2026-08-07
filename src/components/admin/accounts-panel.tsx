"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Building2, Eye, Loader2, Pencil, Plus, Power, PowerOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

interface AdminAccount {
  id: string;
  name: string;
  owner_user_id: string;
  is_active: boolean;
  disabled_at: string | null;
  default_currency: string;
  created_at: string;
  updated_at?: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "view"; account: AdminAccount }
  | { kind: "rename"; account: AdminAccount }
  | { kind: "toggle"; account: AdminAccount };

/**
 * /admin/accounts — the one functional section of the Superadmin
 * area this phase. Consumes the already-existing
 * GET/PATCH /api/admin/accounts[/[id]] routes, all of which are
 * gated server-side by requirePlatformAdmin() (never trust the UI
 * itself as the authority — see the routes for the real check).
 *
 * Deliberately no "create" form: platform_create_account requires an
 * existing auth.users id, and prompting an operator to paste a raw
 * UUID into a form is exactly what this phase was told not to do.
 * The button below is visibly prepared but disabled until 6C.3 wires
 * up user creation.
 */
export function AccountsPanel() {
  const t = useTranslations("Admin.accounts");
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [renameValue, setRenameValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/accounts");
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setAccounts(json.accounts ?? []);
    } catch {
      toast.error(t("toastLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openView(row: AdminAccount) {
    setDialog({ kind: "view", account: row });
    try {
      const res = await fetch(`/api/admin/accounts/${row.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setDialog({ kind: "view", account: json.account });
    } catch {
      toast.error(t("toastLoadFailed"));
    }
  }

  function openRename(row: AdminAccount) {
    setRenameValue(row.name);
    setDialog({ kind: "rename", account: row });
  }

  async function submitRename() {
    if (dialog.kind !== "rename") return;
    const name = renameValue.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${dialog.account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? String(res.status));
      }
      toast.success(t("toastRenamed"));
      setDialog({ kind: "closed" });
      await load();
    } catch {
      toast.error(t("toastRenameFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function submitToggle() {
    if (dialog.kind !== "toggle") return;
    const nextAction = dialog.account.is_active ? "disable" : "enable";
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${dialog.account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: nextAction }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? String(res.status));
      }
      toast.success(nextAction === "enable" ? t("toastEnabled") : t("toastDisabled"));
      setDialog({ kind: "closed" });
      await load();
    } catch {
      toast.error(t("toastToggleFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button disabled title={t("createDisabledHint")}>
          <Plus className="size-4" />
          {t("createButton")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Building2 className="size-4 text-primary" />
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
          ) : accounts.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <>
              {/* Desktop: table. */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colName")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colCurrency")}</TableHead>
                      <TableHead>{t("colCreated")}</TableHead>
                      <TableHead className="text-right">{t("colActions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                        <TableCell>
                          <StatusBadge active={row.is_active} labelActive={t("active")} labelInactive={t("inactive")} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{row.default_currency}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(row.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <RowActions
                            row={row}
                            t={t}
                            onView={() => openView(row)}
                            onRename={() => openRename(row)}
                            onToggle={() => setDialog({ kind: "toggle", account: row })}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile: cards. */}
              <div className="flex flex-col gap-3 md:hidden">
                {accounts.map((row) => (
                  <div key={row.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{row.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.default_currency} · {new Date(row.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <StatusBadge active={row.is_active} labelActive={t("active")} labelInactive={t("inactive")} />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <RowActions
                        row={row}
                        t={t}
                        onView={() => openView(row)}
                        onRename={() => openRename(row)}
                        onToggle={() => setDialog({ kind: "toggle", account: row })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dialog.kind === "view"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("viewTitle")}</DialogTitle>
          </DialogHeader>
          {dialog.kind === "view" && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("colName")}</dt>
              <dd className="text-foreground">{dialog.account.name}</dd>
              <dt className="text-muted-foreground">{t("colStatus")}</dt>
              <dd>
                <StatusBadge
                  active={dialog.account.is_active}
                  labelActive={t("active")}
                  labelInactive={t("inactive")}
                />
              </dd>
              <dt className="text-muted-foreground">{t("colCurrency")}</dt>
              <dd className="text-foreground">{dialog.account.default_currency}</dd>
              <dt className="text-muted-foreground">{t("colCreated")}</dt>
              <dd className="text-foreground">
                {new Date(dialog.account.created_at).toLocaleString()}
              </dd>
              <dt className="text-muted-foreground">{t("viewOwnerId")}</dt>
              <dd className="truncate font-mono text-xs text-muted-foreground">
                {dialog.account.owner_user_id}
              </dd>
              <dt className="text-muted-foreground">{t("viewAccountId")}</dt>
              <dd className="truncate font-mono text-xs text-muted-foreground">{dialog.account.id}</dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog.kind === "rename"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            <DialogDescription>{t("renameDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">{t("colName")}</Label>
            <Input
              id="account-name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={80}
              disabled={saving}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog({ kind: "closed" })} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={submitRename} disabled={saving || !renameValue.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog.kind === "toggle"}
        onOpenChange={(open) => !open && setDialog({ kind: "closed" })}
      >
        <DialogContent>
          {dialog.kind === "toggle" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.account.is_active ? t("disableTitle") : t("enableTitle")}
                </DialogTitle>
                <DialogDescription>
                  {dialog.account.is_active
                    ? t("disableDesc", { name: dialog.account.name })
                    : t("enableDesc", { name: dialog.account.name })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog({ kind: "closed" })} disabled={saving}>
                  {t("cancel")}
                </Button>
                <Button
                  variant={dialog.account.is_active ? "destructive" : "default"}
                  onClick={submitToggle}
                  disabled={saving}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {dialog.account.is_active ? t("disableConfirm") : t("enableConfirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
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
  onView,
  onRename,
  onToggle,
}: {
  row: AdminAccount;
  t: ReturnType<typeof useTranslations>;
  onView: () => void;
  onRename: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="icon-sm" onClick={onView} aria-label={t("view")} title={t("view")}>
        <Eye className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onRename} aria-label={t("editName")} title={t("editName")}>
        <Pencil className="size-4" />
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
