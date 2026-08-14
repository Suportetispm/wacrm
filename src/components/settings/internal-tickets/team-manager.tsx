'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Archive, Loader2, Pencil, Play, Plus, UsersRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { TeamMembersDialog } from './team-members-dialog';
import type { InternalTeam } from '@/types';

interface DraftState {
  id?: string;
  name: string;
  sort_order: number;
}

function emptyDraft(): DraftState {
  return { name: '', sort_order: 0 };
}

const ENDPOINT = '/api/internal-tickets/teams';

/**
 * Settings → Internal Tickets → Teams. internal_teams is exclusive to
 * this module — never `queues`. Membership (internal_team_members)
 * has no physical DELETE (migration 052); removing someone is always
 * is_active=false, handled inside TeamMembersDialog.
 */
export function TeamManager() {
  const t = useTranslations('Settings.internalTeams');
  const canEdit = useCan('edit-settings');

  const [teams, setTeams] = useState<InternalTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [membersTeam, setMembersTeam] = useState<InternalTeam | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setTeams((data.teams as InternalTeam[]) ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((tm) => tm.name.toLowerCase().includes(q));
  }, [teams, search]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (team: InternalTeam) => setDraft({ id: team.id, name: team.name, sort_order: team.sort_order });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    const payload = { name: draft.name.trim(), sort_order: draft.sort_order };

    setSaving(true);
    try {
      const res = await fetch(draft.id ? `${ENDPOINT}/${draft.id}` : ENDPOINT, {
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
  }, [draft, load, t]);

  const toggleActive = useCallback(
    async (team: InternalTeam) => {
      setBusyId(team.id);
      try {
        const res = await fetch(`${ENDPOINT}/${team.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: !team.is_active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('actionFailed'));
          return;
        }
        toast.success(team.is_active ? t('deactivatedToast') : t('activatedToast'));
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, t],
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
          <UsersRound className="mx-auto mb-2 size-6 opacity-50" />
          {t('empty')}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colName')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead>{t('colOrder')}</TableHead>
              <TableHead>{t('colMembers')}</TableHead>
              <TableHead className="text-right">{t('colActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((team) => (
              <TableRow key={team.id}>
                <TableCell className="font-medium">{team.name}</TableCell>
                <TableCell>
                  {team.is_active ? (
                    <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      {t('statusActive')}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">{t('statusInactive')}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{team.sort_order}</TableCell>
                <TableCell className="text-muted-foreground">{team.active_member_count ?? 0}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setMembersTeam(team)} title={t('manageMembersTitle')}>
                      <UsersRound className="size-4" />
                    </Button>
                    {canEdit && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(team)} title={t('editTitle')}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleActive(team)}
                          disabled={busyId === team.id}
                          title={team.is_active ? t('deactivateTitle') : t('activateTitle')}
                        >
                          {team.is_active ? <Archive className="size-4" /> : <Play className="size-4" />}
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t('editDialogTitle') : t('newDialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="internal-team-name">{t('fieldName')}</Label>
                <Input
                  id="internal-team-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={120}
                />
              </div>
              <div>
                <Label htmlFor="internal-team-sort">{t('fieldSortOrder')}</Label>
                <Input
                  id="internal-team-sort"
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

      {membersTeam && (
        <TeamMembersDialog
          team={membersTeam}
          open={membersTeam !== null}
          onOpenChange={(open) => {
            if (!open) setMembersTeam(null);
          }}
          onMembersChanged={load}
        />
      )}
    </div>
  );
}
