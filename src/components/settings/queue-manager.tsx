'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Archive, Loader2, ListTodo, Pause, Play, Plus, Settings2, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { SettingsPanelHead } from './settings-panel-head';
import { QueueMembersDialog } from './queue-members-dialog';
import type { Queue, QueueFailureAction, TicketPriority } from '@/types';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

const FAILURE_ACTIONS: readonly QueueFailureAction[] = ['stay_in_queue', 'remove_queue', 'transfer_queue'];
const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

interface DraftState {
  id?: string;
  name: string;
  color: string;
  greeting_message: string;
  out_of_hours_message: string;
  chatbot_max_attempts: number;
  chatbot_failure_message: string;
  chatbot_failure_action: QueueFailureAction;
  chatbot_failure_queue_id: string;
  auto_assignment_enabled: boolean;
  default_wait_minutes: number;
  default_priority: TicketPriority;
}

function emptyDraft(): DraftState {
  return {
    name: '',
    color: PRESET_COLORS[5],
    greeting_message: '',
    out_of_hours_message: '',
    chatbot_max_attempts: 3,
    chatbot_failure_message: '',
    chatbot_failure_action: 'stay_in_queue',
    chatbot_failure_queue_id: '',
    auto_assignment_enabled: false,
    default_wait_minutes: 5,
    default_priority: 'normal',
  };
}

/**
 * Settings → Queues. Admin/owner only — the rail entry itself is
 * hidden for agent/viewer (settings-sections.ts `adminOnly` + the
 * role check in settings-rail.tsx); RequireRole here is the second,
 * component-level layer for the (rare) direct-URL-navigation case —
 * server-side routes remain the real enforcement (`requireRole('admin')`
 * on every write). Never permits physical deletion — only pause/
 * activate/archive, mirroring what the DB itself allows (no DELETE
 * RLS policy exists for `queues`).
 */
export function QueueManager() {
  const t = useTranslations('Settings.queues');
  return (
    <RequireRole
      min="admin"
      fallback={
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('adminOnlyNotice')}
        </div>
      }
    >
      <QueueManagerContent />
    </RequireRole>
  );
}

function QueueManagerContent() {
  const t = useTranslations('Settings.queues');
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [membersQueue, setMembersQueue] = useState<Queue | null>(null);

  const FAILURE_ACTION_LABEL: Record<QueueFailureAction, string> = {
    stay_in_queue: t('failureActionStay'),
    remove_queue: t('failureActionRemove'),
    transfer_queue: t('failureActionTransfer'),
  };
  const PRIORITY_LABEL: Record<TicketPriority, string> = {
    low: t('priorityLow'),
    normal: t('priorityNormal'),
    high: t('priorityHigh'),
    urgent: t('priorityUrgent'),
  };

  function queueStatusBadge(queue: Queue) {
    if (queue.archived_at) return <Badge variant="outline">{t('statusArchived')}</Badge>;
    if (!queue.is_active) return <Badge variant="secondary">{t('statusPaused')}</Badge>;
    return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{t('statusActive')}</Badge>;
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/queues', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setQueues((data.queues as Queue[]) ?? []);
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
    if (!q) return queues;
    return queues.filter((qu) => qu.name.toLowerCase().includes(q));
  }, [queues, search]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (queue: Queue) =>
    setDraft({
      id: queue.id,
      name: queue.name,
      color: queue.color,
      greeting_message: queue.greeting_message ?? '',
      out_of_hours_message: queue.out_of_hours_message ?? '',
      chatbot_max_attempts: queue.chatbot_max_attempts,
      chatbot_failure_message: queue.chatbot_failure_message ?? '',
      chatbot_failure_action: queue.chatbot_failure_action,
      chatbot_failure_queue_id: queue.chatbot_failure_queue_id ?? '',
      auto_assignment_enabled: queue.auto_assignment_enabled,
      default_wait_minutes: queue.default_wait_minutes,
      default_priority: queue.default_priority,
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    if (draft.chatbot_failure_action === 'transfer_queue' && !draft.chatbot_failure_queue_id) {
      toast.error(t('transferTargetRequired'));
      return;
    }

    const payload = {
      name: draft.name.trim(),
      color: draft.color,
      greeting_message: draft.greeting_message || null,
      out_of_hours_message: draft.out_of_hours_message || null,
      chatbot_max_attempts: draft.chatbot_max_attempts,
      chatbot_failure_message: draft.chatbot_failure_message || null,
      chatbot_failure_action: draft.chatbot_failure_action,
      chatbot_failure_queue_id:
        draft.chatbot_failure_action === 'transfer_queue' ? draft.chatbot_failure_queue_id : null,
      auto_assignment_enabled: draft.auto_assignment_enabled,
      default_wait_minutes: draft.default_wait_minutes,
      default_priority: draft.default_priority,
    };

    setSaving(true);
    try {
      const res = await fetch(draft.id ? `/api/queues/${draft.id}` : '/api/queues', {
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

  const applyAction = useCallback(
    async (queue: Queue, action: 'pause' | 'activate' | 'archive') => {
      setBusyId(queue.id);
      try {
        const res = await fetch(`/api/queues/${queue.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('actionFailed'));
          return;
        }
        toast.success(
          action === 'archive' ? t('archivedToast') : action === 'pause' ? t('pausedToast') : t('activatedToast'),
        );
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, t],
  );

  const transferTargets = queues.filter((q) => q.id !== draft?.id && !q.archived_at);

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            {t('newQueue')}
          </Button>
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
          <ListTodo className="mx-auto mb-2 size-6 opacity-50" />
          {t('empty')}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colQueue')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead>{t('colPriority')}</TableHead>
              <TableHead>{t('colWait')}</TableHead>
              <TableHead className="text-right">{t('colActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((queue) => (
              <TableRow key={queue.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: queue.color }} />
                    <span className="font-medium">{queue.name}</span>
                  </div>
                </TableCell>
                <TableCell>{queueStatusBadge(queue)}</TableCell>
                <TableCell className="text-muted-foreground">{PRIORITY_LABEL[queue.default_priority]}</TableCell>
                <TableCell className="text-muted-foreground">{queue.default_wait_minutes}m</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setMembersQueue(queue)} title={t('membersTitle')}>
                      <Users className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(queue)}
                      disabled={Boolean(queue.archived_at)}
                      title={t('editTitle')}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                    {!queue.archived_at && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => applyAction(queue, queue.is_active ? 'pause' : 'activate')}
                        disabled={busyId === queue.id}
                        title={queue.is_active ? t('pauseTitle') : t('activateTitle')}
                      >
                        {queue.is_active ? <Pause className="size-4" /> : <Play className="size-4" />}
                      </Button>
                    )}
                    {!queue.archived_at && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => applyAction(queue, 'archive')}
                        disabled={busyId === queue.id}
                        title={t('archiveTitle')}
                      >
                        <Archive className="size-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
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
                <Label htmlFor="queue-name">{t('fieldName')}</Label>
                <Input
                  id="queue-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={80}
                />
              </div>

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

              <div>
                <Label htmlFor="queue-greeting">{t('fieldGreeting')}</Label>
                <Textarea
                  id="queue-greeting"
                  value={draft.greeting_message}
                  onChange={(e) => setDraft({ ...draft, greeting_message: e.target.value })}
                  rows={2}
                />
              </div>

              <div>
                <Label htmlFor="queue-oohours">{t('fieldOutOfHours')}</Label>
                <Textarea
                  id="queue-oohours"
                  value={draft.out_of_hours_message}
                  onChange={(e) => setDraft({ ...draft, out_of_hours_message: e.target.value })}
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="queue-wait">{t('fieldWait')}</Label>
                  <Input
                    id="queue-wait"
                    type="number"
                    min={1}
                    max={60}
                    value={draft.default_wait_minutes}
                    onChange={(e) =>
                      setDraft({ ...draft, default_wait_minutes: Number(e.target.value) || 1 })
                    }
                  />
                </div>
                <div>
                  <Label>{t('fieldPriority')}</Label>
                  <Select
                    value={draft.default_priority}
                    onValueChange={(v) => setDraft({ ...draft, default_priority: (v ?? 'normal') as TicketPriority })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor="queue-auto-assign">{t('fieldAutoAssign')}</Label>
                  <p className="text-xs text-muted-foreground">{t('fieldAutoAssignDesc')}</p>
                </div>
                <Switch
                  id="queue-auto-assign"
                  checked={draft.auto_assignment_enabled}
                  onCheckedChange={(v) => setDraft({ ...draft, auto_assignment_enabled: v })}
                />
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t('chatbotSectionTitle')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="queue-max-attempts">{t('fieldMaxAttempts')}</Label>
                    <Input
                      id="queue-max-attempts"
                      type="number"
                      min={1}
                      max={10}
                      value={draft.chatbot_max_attempts}
                      onChange={(e) =>
                        setDraft({ ...draft, chatbot_max_attempts: Number(e.target.value) || 1 })
                      }
                    />
                  </div>
                  <div>
                    <Label>{t('fieldOnFailure')}</Label>
                    <Select
                      value={draft.chatbot_failure_action}
                      onValueChange={(v) =>
                        setDraft({ ...draft, chatbot_failure_action: (v ?? 'stay_in_queue') as QueueFailureAction })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FAILURE_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>{FAILURE_ACTION_LABEL[a]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {draft.chatbot_failure_action === 'transfer_queue' && (
                  <div>
                    <Label>{t('fieldTransferTo')}</Label>
                    <Select
                      value={draft.chatbot_failure_queue_id}
                      onValueChange={(v) => setDraft({ ...draft, chatbot_failure_queue_id: v ?? '' })}
                    >
                      <SelectTrigger><SelectValue placeholder={t('transferToPlaceholder')} /></SelectTrigger>
                      <SelectContent>
                        {transferTargets.map((q) => (
                          <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <Label htmlFor="queue-failure-msg">{t('fieldFailureMessage')}</Label>
                  <Textarea
                    id="queue-failure-msg"
                    value={draft.chatbot_failure_message}
                    onChange={(e) => setDraft({ ...draft, chatbot_failure_message: e.target.value })}
                    rows={2}
                  />
                </div>
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

      {membersQueue && (
        <QueueMembersDialog
          queue={membersQueue}
          open={membersQueue !== null}
          onOpenChange={(open) => !open && setMembersQueue(null)}
        />
      )}
    </div>
  );
}
