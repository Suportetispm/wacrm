'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { AccountMember, InternalTeam, InternalTeamMember } from '@/types';

interface TeamMembersDialogProps {
  team: InternalTeam;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refreshes the parent team list's active_member_count after any
   *  add/reactivate/deactivate — this dialog only owns its own list. */
  onMembersChanged: () => void;
}

/**
 * Add/reactivate/deactivate members of one internal team. Unlike
 * queue_members, internal_team_members has NO physical DELETE
 * (migration 052) — the only mutation is is_active, via PATCH. The
 * picker excludes anyone already listed (active or inactive): an
 * inactive row is shown in the list with its switch off, never
 * offered again through "add" (the server would reactivate it anyway
 * — see teams/[id]/members POST — but the picker hides the need).
 * Only active profiles are offered as candidates.
 */
export function TeamMembersDialog({ team, open, onOpenChange, onMembersChanged }: TeamMembersDialogProps) {
  const t = useTranslations('Settings.internalTeamMembers');
  const canEdit = useCan('edit-settings');
  const [members, setMembers] = useState<InternalTeamMember[]>([]);
  const [accountMembers, setAccountMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [membersRes, accountRes] = await Promise.all([
        fetch(`/api/internal-tickets/teams/${team.id}/members`, { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      const membersData = await membersRes.json().catch(() => ({}));
      const accountData = await accountRes.json().catch(() => ({}));
      if (membersRes.ok) setMembers((membersData.members as InternalTeamMember[]) ?? []);
      if (accountRes.ok) setAccountMembers((accountData.members as AccountMember[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Only active profiles are eligible, and only if not already listed
  // here (active or inactive) — an inactive existing row is reactivated
  // via its own switch below, never through this picker.
  const availableToAdd = accountMembers.filter(
    (am) => am.is_active && !members.some((m) => m.user_id === am.user_id),
  );

  const addMember = useCallback(async () => {
    if (!selectedUserId) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/internal-tickets/teams/${team.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: selectedUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('addFailed'));
        return;
      }
      toast.success(t('addedToast'));
      setSelectedUserId('');
      await load();
      onMembersChanged();
    } finally {
      setAdding(false);
    }
  }, [team.id, selectedUserId, load, onMembersChanged, t]);

  const toggleActive = useCallback(
    async (member: InternalTeamMember) => {
      setBusyId(member.id);
      try {
        const res = await fetch(`/api/internal-tickets/teams/${team.id}/members/${member.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: !member.is_active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('updateFailed'));
          return;
        }
        toast.success(member.is_active ? t('deactivatedToast') : t('activatedToast'));
        await load();
        onMembersChanged();
      } finally {
        setBusyId(null);
      }
    },
    [team.id, load, onMembersChanged, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { name: team.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            {canEdit && (
              <div className="flex gap-2">
                <Select value={selectedUserId} onValueChange={(v) => setSelectedUserId(v ?? '')}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={t('pickPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableToAdd.map((am) => (
                      <SelectItem key={am.user_id} value={am.user_id}>
                        {am.full_name || am.email || am.user_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={addMember} disabled={!selectedUserId || adding} size="sm">
                  {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t('add')}
                </Button>
              </div>
            )}

            {members.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="space-y-2">
                {members.map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {member.profile?.full_name || member.profile?.email || member.user_id}
                      </p>
                      <Badge variant={member.is_active ? 'secondary' : 'outline'} className="mt-1">
                        {member.is_active ? t('active') : t('inactive')}
                      </Badge>
                    </div>
                    <Switch
                      checked={member.is_active}
                      disabled={!canEdit || busyId === member.id}
                      onCheckedChange={() => toggleActive(member)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
