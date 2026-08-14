'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Archive, Loader2, type LucideIcon, Pencil, Play, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from '../settings-panel-head';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

/**
 * Shared shape of internal_ticket_statuses and internal_ticket_stages
 * — both are (name, [color], is_active, is_terminal, is_default,
 * sort_order) catalogs with identical "at most one default, a default
 * must stay active" rules (DB partial unique index + CHECK, migration
 * 052). `hasColor` is the only real difference between the two
 * (statuses have it, stages don't) — one component covers both.
 */
export interface DefaultAwareCatalogItem {
  id: string;
  name: string;
  color?: string;
  is_active: boolean;
  is_terminal: boolean;
  is_default: boolean;
  sort_order: number;
}

interface DraftState {
  id?: string;
  name: string;
  color: string;
  sort_order: number;
  is_terminal: boolean;
  is_default: boolean;
}

function emptyDraft(): DraftState {
  return { name: '', color: PRESET_COLORS[5], sort_order: 0, is_terminal: false, is_default: false };
}

export function DefaultAwareCatalogManager({
  namespace,
  endpoint,
  listKey,
  hasColor,
  icon: Icon,
}: {
  /** i18n namespace, e.g. "Settings.internalTicketStatuses". */
  namespace: string;
  /** e.g. "/api/internal-tickets/statuses". */
  endpoint: string;
  /** Key holding the array in the GET response, e.g. "statuses". */
  listKey: string;
  hasColor: boolean;
  icon: LucideIcon;
}) {
  const t = useTranslations(namespace);
  const canEdit = useCan('edit-settings');

  const [items, setItems] = useState<DefaultAwareCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data[listKey] as DefaultAwareCatalogItem[]) ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, listKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.name.toLowerCase().includes(q));
  }, [items, search]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (item: DefaultAwareCatalogItem) =>
    setDraft({
      id: item.id,
      name: item.name,
      color: item.color ?? PRESET_COLORS[5],
      sort_order: item.sort_order,
      is_terminal: item.is_terminal,
      is_default: item.is_default,
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      sort_order: draft.sort_order,
      is_terminal: draft.is_terminal,
      is_default: draft.is_default,
    };
    if (hasColor) payload.color = draft.color;

    setSaving(true);
    try {
      const res = await fetch(draft.id ? `${endpoint}/${draft.id}` : endpoint, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      // `warning` (never `error`) means: the row was created/updated,
      // but promoting it to default failed after that already
      // committed (migration 053) — the row is real and the list
      // below reflects it; surface the partial outcome instead of a
      // plain success toast that would hide it.
      if (typeof data.warning === 'string') {
        toast.warning(data.warning);
      } else {
        toast.success(draft.id ? t('updated') : t('created'));
      }
      setDraft(null);
      await load();
    } finally {
      setSaving(false);
    }
  }, [draft, endpoint, hasColor, load, t]);

  const toggleActive = useCallback(
    async (item: DefaultAwareCatalogItem) => {
      // UI-side prevention (item 3): the default must stay active — the
      // Archive button is disabled for the current default (below), so
      // this branch is defense in depth only; the DB CHECK is still the
      // final authority either way.
      if (item.is_default && item.is_active) {
        toast.error(t('cannotDeactivateDefault'));
        return;
      }
      setBusyId(item.id);
      try {
        const res = await fetch(`${endpoint}/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: !item.is_active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('actionFailed'));
          return;
        }
        toast.success(item.is_active ? t('deactivatedToast') : t('activatedToast'));
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [endpoint, load, t],
  );

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEdit ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              {t('new')}
            </Button>
          ) : undefined
        }
      />

      <Input
        placeholder={t('searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 max-w-xs"
      />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <Icon className="mx-auto mb-2 size-6 opacity-50" />
          {t('empty')}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colName')}</TableHead>
              <TableHead>{t('colDefault')}</TableHead>
              <TableHead>{t('colTerminal')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead>{t('colOrder')}</TableHead>
              {canEdit && <TableHead className="text-right">{t('colActions')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium">
                    {hasColor && item.color ? (
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    ) : null}
                    {item.name}
                  </div>
                </TableCell>
                <TableCell>
                  {item.is_default ? <Badge className="bg-primary-soft text-primary">{t('defaultBadge')}</Badge> : null}
                </TableCell>
                <TableCell>
                  {item.is_terminal ? <Badge variant="outline">{t('terminalBadge')}</Badge> : null}
                </TableCell>
                <TableCell>
                  {item.is_active ? (
                    <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      {t('statusActive')}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">{t('statusInactive')}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{item.sort_order}</TableCell>
                {canEdit && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(item)} title={t('editTitle')}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleActive(item)}
                        disabled={busyId === item.id || (item.is_default && item.is_active)}
                        title={
                          item.is_default && item.is_active
                            ? t('cannotDeactivateDefaultTitle')
                            : item.is_active
                              ? t('deactivateTitle')
                              : t('activateTitle')
                        }
                      >
                        {item.is_active ? <Archive className="size-4" /> : <Play className="size-4" />}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t('editDialogTitle') : t('newDialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div>
                <Label htmlFor={`${namespace}-name`}>{t('fieldName')}</Label>
                <Input
                  id={`${namespace}-name`}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={120}
                />
              </div>

              {hasColor && (
                <div>
                  <Label>{t('fieldColor')}</Label>
                  <div className="mt-1.5 flex gap-1.5">
                    {PRESET_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setDraft({ ...draft, color })}
                        aria-pressed={draft.color === color}
                        className="size-6 rounded-md transition-transform hover:scale-110 data-[active=true]:outline data-[active=true]:outline-2 data-[active=true]:outline-offset-2 data-[active=true]:outline-primary"
                        data-active={draft.color === color}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor={`${namespace}-sort`}>{t('fieldSortOrder')}</Label>
                <Input
                  id={`${namespace}-sort`}
                  type="number"
                  value={draft.sort_order}
                  onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) || 0 })}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor={`${namespace}-terminal`}>{t('fieldTerminal')}</Label>
                  <p className="text-xs text-muted-foreground">{t('fieldTerminalDesc')}</p>
                </div>
                <Switch
                  id={`${namespace}-terminal`}
                  checked={draft.is_terminal}
                  onCheckedChange={(v) => setDraft({ ...draft, is_terminal: v })}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor={`${namespace}-default`}>{t('fieldDefault')}</Label>
                  <p className="text-xs text-muted-foreground">{t('fieldDefaultDesc')}</p>
                </div>
                <Switch
                  id={`${namespace}-default`}
                  checked={draft.is_default}
                  onCheckedChange={(v) => setDraft({ ...draft, is_default: v })}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
