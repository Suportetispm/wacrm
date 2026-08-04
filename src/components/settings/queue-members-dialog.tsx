'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import type { Queue, QueueMember, QueueMemberRole } from '@/types';

interface AccountMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

interface QueueMembersDialogProps {
  queue: Queue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Add/remove members of one queue, and edit their per-membership
 * settings (role, weight, individual wait override, active-ticket
 * cap). The user picker is every account member (GET
 * /api/account/members — already tenancy-scoped) minus whoever is
 * already in this queue; the server independently re-validates that
 * tenancy regardless of what this list shows (POST /api/queues/[id]/members).
 */
export function QueueMembersDialog({ queue, open, onOpenChange }: QueueMembersDialogProps) {
  const t = useTranslations('Settings.queueMembers');
  const [members, setMembers] = useState<QueueMember[]>([]);
  const [accountMembers, setAccountMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [membersRes, accountRes] = await Promise.all([
        fetch(`/api/queues/${queue.id}/members`, { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      const membersData = await membersRes.json().catch(() => ({}));
      const accountData = await accountRes.json().catch(() => ({}));
      if (membersRes.ok) setMembers((membersData.members as QueueMember[]) ?? []);
      if (accountRes.ok) setAccountMembers((accountData.members as AccountMember[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [queue.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const availableToAdd = accountMembers.filter(
    (am) => !members.some((m) => m.user_id === am.user_id),
  );

  const addMember = useCallback(async () => {
    if (!selectedUserId) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/queues/${queue.id}/members`, {
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
    } finally {
      setAdding(false);
    }
  }, [queue.id, selectedUserId, load, t]);

  const updateMember = useCallback(
    async (member: QueueMember, patch: Partial<Pick<QueueMember, 'role_in_queue' | 'weight' | 'individual_wait_minutes' | 'max_active_tickets' | 'is_active'>>) => {
      setBusyId(member.id);
      try {
        const res = await fetch(`/api/queues/${queue.id}/members/${member.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('updateFailed'));
          return;
        }
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [queue.id, load, t],
  );

  const removeMember = useCallback(
    async (member: QueueMember) => {
      setBusyId(member.id);
      try {
        const res = await fetch(`/api/queues/${queue.id}/members/${member.id}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('removeFailed'));
          return;
        }
        toast.success(t('removedToast'));
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [queue.id, load, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { name: queue.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4">
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

            {members.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="space-y-2">
                {members.map((member) => (
                  <li key={member.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {member.profile?.full_name || member.profile?.email || member.user_id}
                        </p>
                        <Badge variant={member.is_active ? 'secondary' : 'outline'} className="mt-1">
                          {member.is_active ? t('active') : t('inactive')}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={member.is_active}
                          disabled={busyId === member.id}
                          onCheckedChange={(v) => updateMember(member, { is_active: v })}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === member.id}
                          onClick={() => removeMember(member)}
                          title={t('removeTitle')}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <Select
                        value={member.role_in_queue}
                        onValueChange={(v) => updateMember(member, { role_in_queue: (v ?? 'agent') as QueueMemberRole })}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="agent">{t('roleAgent')}</SelectItem>
                          <SelectItem value="supervisor">{t('roleSupervisor')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={member.weight}
                        onChange={(e) => updateMember(member, { weight: Number(e.target.value) || 1 })}
                        className="h-8 text-xs"
                        title={t('weightTitle')}
                      />
                      <Input
                        type="number"
                        min={1}
                        placeholder={t('maxTicketsPlaceholder')}
                        value={member.max_active_tickets ?? ''}
                        onChange={(e) =>
                          updateMember(member, {
                            max_active_tickets: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="h-8 text-xs"
                        title={t('maxTicketsTitle')}
                      />
                    </div>
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
