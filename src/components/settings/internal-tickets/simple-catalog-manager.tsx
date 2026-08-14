'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Archive, Loader2, type LucideIcon, Pencil, Play, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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

/**
 * Shared shape of internal_ticket_types and internal_companies — both
 * are (name, description, is_active, sort_order) catalogs with
 * identical behavior (no DELETE, archive via is_active). One
 * component covers both instead of two near-duplicate ~300-line
 * files; the two callers (types-manager / companies-manager) just
 * supply the endpoint, i18n namespace and icon.
 */
export interface SimpleCatalogItem {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

interface DraftState {
  id?: string;
  name: string;
  description: string;
  sort_order: number;
}

function emptyDraft(): DraftState {
  return { name: '', description: '', sort_order: 0 };
}

export function SimpleCatalogManager({
  namespace,
  endpoint,
  listKey,
  icon: Icon,
}: {
  /** i18n namespace, e.g. "Settings.internalTicketTypes". */
  namespace: string;
  /** e.g. "/api/internal-tickets/types". */
  endpoint: string;
  /** Key holding the array in the GET response, e.g. "types". */
  listKey: string;
  icon: LucideIcon;
}) {
  const t = useTranslations(namespace);
  const canEdit = useCan('edit-settings');

  const [items, setItems] = useState<SimpleCatalogItem[]>([]);
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
      if (res.ok) setItems((data[listKey] as SimpleCatalogItem[]) ?? []);
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
  const openEdit = (item: SimpleCatalogItem) =>
    setDraft({
      id: item.id,
      name: item.name,
      description: item.description ?? '',
      sort_order: item.sort_order,
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    const payload = {
      name: draft.name.trim(),
      description: draft.description || null,
      sort_order: draft.sort_order,
    };

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
      toast.success(draft.id ? t('updated') : t('created'));
      setDraft(null);
      await load();
    } finally {
      setSaving(false);
    }
  }, [draft, endpoint, load, t]);

  const toggleActive = useCallback(
    async (item: SimpleCatalogItem) => {
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
              <TableHead>{t('colDescription')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead>{t('colOrder')}</TableHead>
              {canEdit && <TableHead className="text-right">{t('colActions')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.name}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {item.description || '—'}
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
                        disabled={busyId === item.id}
                        title={item.is_active ? t('deactivateTitle') : t('activateTitle')}
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
              <div>
                <Label htmlFor={`${namespace}-description`}>{t('fieldDescription')}</Label>
                <Textarea
                  id={`${namespace}-description`}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                />
              </div>
              <div>
                <Label htmlFor={`${namespace}-sort`}>{t('fieldSortOrder')}</Label>
                <Input
                  id={`${namespace}-sort`}
                  type="number"
                  value={draft.sort_order}
                  onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) || 0 })}
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
