'use client';

import { useCallback, useEffect, useState, use as usePromise } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  classifyTicketActionError,
  deriveOperationalStatus,
  isAdminOrOwner,
  visibleTicketActions,
  buildCloseTicketPayload,
  type OperationalStatus,
} from '@/lib/tickets/status';
import { eligibleTransferAgentCandidates, type TransferAgentCandidate } from '@/lib/tickets/candidates';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import type { AccountMember, Queue, Ticket, TicketEvent, TicketPriority } from '@/types';

const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  normal: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  high: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const OP_STATUS_BADGE: Record<OperationalStatus, string> = {
  in_queue: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  in_progress: 'bg-primary/15 text-primary',
  waiting_customer: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  closed: 'bg-muted text-muted-foreground',
  finalized: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type DialogState =
  | { kind: 'closed' }
  | { kind: 'transfer-queue' }
  | { kind: 'transfer-agent' }
  | { kind: 'close'; finalize: boolean };

/**
 * Ticket detail + timeline + operational actions (6E.4). Business
 * authority stays entirely in the API/RPC layer
 * (POST /api/tickets/[id]/{claim,transfer-queue,transfer-agent,
 * waiting-customer,resume,close} → the RPCs in migration 049) — this
 * page only calls those routes and reflects their result; it never
 * writes to `tickets`/`conversations` directly.
 */
export default function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const t = useTranslations('Tickets');
  const td = useTranslations('Tickets.detail');
  const te = useTranslations('Tickets.events');
  const ta = useTranslations('Tickets.actions');
  const { user, accountRole, account } = useAuth();

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });

  const PRIORITY_LABEL: Record<TicketPriority, string> = {
    low: t('priorityLow'),
    normal: t('priorityNormal'),
    high: t('priorityHigh'),
    urgent: t('priorityUrgent'),
  };
  const OP_STATUS_LABEL: Record<OperationalStatus, string> = {
    in_queue: t('opStatusInQueue'),
    in_progress: t('opStatusInProgress'),
    waiting_customer: t('opStatusWaitingCustomer'),
    closed: t('opStatusClosed'),
    finalized: t('opStatusFinalized'),
  };
  const EVENT_LABEL: Record<TicketEvent['event_type'], string> = {
    created: te('created'),
    status_changed: te('statusChanged'),
    priority_changed: te('priorityChanged'),
    assigned: te('assigned'),
    transferred_queue: te('transferredQueue'),
    transferred_agent: te('transferredAgent'),
    closed: te('closed'),
    reopened: te('reopened'),
  };

  const loadTicket = useCallback(async () => {
    try {
      const res = await fetch(`/api/tickets/${id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? td('loadFailed'));
        return;
      }
      setTicket(data.ticket as Ticket);
      setEvents((data.events as TicketEvent[]) ?? []);
    } catch {
      toast.error(td('loadFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setLoading(true);
    loadTicket().finally(() => setLoading(false));
  }, [loadTicket]);

  useEffect(() => {
    fetchAccountMembers().then(setMembers);
    fetch('/api/queues', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setQueues((d.queues as Queue[]) ?? []))
      .catch(() => {});
  }, []);

  function friendlyError(status: number, body: { error?: unknown } | null): string {
    const info = classifyTicketActionError(status, body);
    if (info.translatedKey) return ta(info.translatedKey);
    return info.detail ?? ta('errorGeneric');
  }

  async function runAction(
    url: string,
    payload: unknown,
    successToastKey: Parameters<typeof ta>[0],
  ) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(friendlyError(res.status, data));
        return false;
      }
      toast.success(ta(successToastKey));
      await loadTicket();
      return true;
    } finally {
      setBusy(false);
    }
  }

  const handleClaim = () => void runAction(`/api/tickets/${id}/claim`, undefined, 'toastClaimed');
  const handleWaitCustomer = () =>
    void runAction(`/api/tickets/${id}/waiting-customer`, undefined, 'toastWaiting');
  const handleResume = () => void runAction(`/api/tickets/${id}/resume`, undefined, 'toastResumed');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !ticket) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        {td('notFound')}
      </div>
    );
  }

  const opState = deriveOperationalStatus(ticket);
  const actions = visibleTicketActions(ticket, {
    isAdminOrOwner: isAdminOrOwner(accountRole),
    currentUserId: user?.id ?? null,
  });
  const memberById = new Map(members.map((m) => [m.user_id, m]));
  const assignee = ticket.assigned_agent_id ? memberById.get(ticket.assigned_agent_id) : null;

  return (
    <div>
      <Link href="/tickets" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {td('backToTickets')}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{td('titleWithNumber', { number: ticket.ticket_number })}</h1>
        <Badge className={OP_STATUS_BADGE[opState]}>{OP_STATUS_LABEL[opState]}</Badge>
        <Badge className={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</Badge>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td('timelineTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">{td('noEvents')}</p>
            ) : (
              <ol className="space-y-4">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <div className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{EVENT_LABEL[event.event_type] ?? event.event_type}</p>
                      {(event.from_value || event.to_value) && (
                        <p className="text-xs text-muted-foreground">
                          {event.from_value ? `${event.from_value} → ` : ''}
                          {event.to_value ?? ''}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">{fmtDate(event.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {(actions.claim || actions.transferQueue || actions.transferAgent || actions.waitCustomer || actions.resume || actions.close) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{td('actionsTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {actions.claim && (
                  <Button size="sm" onClick={handleClaim} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {ta('actionClaim')}
                  </Button>
                )}
                {actions.waitCustomer && (
                  <Button size="sm" variant="outline" onClick={handleWaitCustomer} disabled={busy}>
                    {ta('actionWaitCustomer')}
                  </Button>
                )}
                {actions.resume && (
                  <Button size="sm" variant="outline" onClick={handleResume} disabled={busy}>
                    {ta('actionResume')}
                  </Button>
                )}
                {actions.transferQueue && (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'transfer-queue' })} disabled={busy}>
                    {ta('actionTransferQueue')}
                  </Button>
                )}
                {actions.transferAgent && (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'transfer-agent' })} disabled={busy}>
                    {ta('actionTransferAgent')}
                  </Button>
                )}
                {actions.close && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDialog({ kind: 'close', finalize: false })}
                    disabled={busy}
                  >
                    {ta('actionClose')}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{td('detailsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">{td('contactLabel')}</p>
                <p className="font-medium">{ticket.contact?.name || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{td('phoneLabel')}</p>
                <p>{ticket.contact?.phone || '—'}</p>
              </div>
              {account && (
                <div>
                  <p className="text-xs text-muted-foreground">{td('companyLabel')}</p>
                  <p>{account.name}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">{td('queueLabel')}</p>
                {ticket.queue ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: ticket.queue.color }} />
                    {ticket.queue.name}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t('untriaged')}</span>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{td('assigneeLabel')}</p>
                <p>{assignee ? memberLabel(assignee) : <span className="text-muted-foreground">{t('unassigned')}</span>}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{td('openedLabel')}</p>
                <p>{fmtDate(ticket.opened_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{td('updatedLabel')}</p>
                <p>{fmtDate(ticket.updated_at)}</p>
              </div>
              {ticket.closed_at && (
                <div>
                  <p className="text-xs text-muted-foreground">{td('closedLabel')}</p>
                  <p>{fmtDate(ticket.closed_at)}</p>
                </div>
              )}
              {ticket.close_reason && (
                <div>
                  <p className="text-xs text-muted-foreground">{td('closeReasonLabel')}</p>
                  <p>{ticket.close_reason}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">{td('conversationLabel')}</p>
                <Link
                  href={`/inbox?c=${ticket.conversation_id}`}
                  className="text-primary hover:underline"
                >
                  {td('openInInbox')}
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <TransferQueueDialog
        open={dialog.kind === 'transfer-queue'}
        onOpenChange={(open) => !open && setDialog({ kind: 'closed' })}
        queues={queues.filter((q) => q.is_active && q.id !== ticket.queue_id)}
        submitting={busy}
        onSubmit={async (queueId) => {
          const ok = await runAction(`/api/tickets/${id}/transfer-queue`, { queue_id: queueId }, 'toastTransferQueue');
          if (ok) setDialog({ kind: 'closed' });
        }}
      />

      <TransferAgentDialog
        open={dialog.kind === 'transfer-agent'}
        onOpenChange={(open) => !open && setDialog({ kind: 'closed' })}
        members={members}
        currentQueueId={ticket.queue_id}
        currentAssigneeId={ticket.assigned_agent_id}
        submitting={busy}
        onSubmit={async (agentUserId) => {
          const ok = await runAction(`/api/tickets/${id}/transfer-agent`, { agent_user_id: agentUserId }, 'toastTransferAgent');
          if (ok) setDialog({ kind: 'closed' });
        }}
      />

      <CloseTicketDialog
        open={dialog.kind === 'close'}
        onOpenChange={(open) => !open && setDialog({ kind: 'closed' })}
        submitting={busy}
        onSubmit={async (finalize, closeReason) => {
          const payload = buildCloseTicketPayload(finalize, closeReason);
          const ok = await runAction(
            `/api/tickets/${id}/close`,
            payload,
            finalize ? 'toastFinalized' : 'toastClosed',
          );
          if (ok) setDialog({ kind: 'closed' });
        }}
      />
    </div>
  );
}

function TransferQueueDialog({
  open,
  onOpenChange,
  queues,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queues: Queue[];
  submitting: boolean;
  onSubmit: (queueId: string) => void;
}) {
  const t = useTranslations('Tickets.transferQueueDialog');
  const [queueId, setQueueId] = useState('');

  // Reset the selection when the dialog closes — legitimate
  // prop-driven sync, same pattern as pipeline-settings.tsx/
  // deal-form.tsx.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setQueueId('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {queues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noActiveQueues')}</p>
        ) : (
          <div className="space-y-2">
            <Label>{t('queueLabel')}</Label>
            <Select value={queueId} onValueChange={(v) => setQueueId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('queuePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {queues.map((q) => (
                  <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={() => onSubmit(queueId)} disabled={!queueId || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferAgentDialog({
  open,
  onOpenChange,
  members,
  currentQueueId,
  currentAssigneeId,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: AccountMember[];
  currentQueueId: string | null;
  currentAssigneeId: string | null;
  submitting: boolean;
  onSubmit: (agentUserId: string) => void;
}) {
  const t = useTranslations('Tickets.transferAgentDialog');
  const [agentUserId, setAgentUserId] = useState('');
  const [candidates, setCandidates] = useState<TransferAgentCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  // Loads eligible candidates on open/dependency change. The reset and
  // the loading flag are synchronous, legitimate prop-driven sync (same
  // pattern as contact-sidebar.tsx/custom-fields-manager.tsx);
  // setCandidates/setLoadingCandidates(false) below run inside the
  // async callback, not synchronously in the effect body.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAgentUserId('');
      return;
    }
    let cancelled = false;
    setLoadingCandidates(true);
    (async () => {
      let queueMemberIds: string[] | null = null;
      if (currentQueueId) {
        try {
          const res = await fetch(`/api/queues/${currentQueueId}/members`, { cache: 'no-store' });
          const data = await res.json().catch(() => ({}));
          const rows = (data.members as { user_id: string; is_active: boolean }[] | undefined) ?? [];
          queueMemberIds = rows.filter((m) => m.is_active).map((m) => m.user_id);
        } catch {
          queueMemberIds = [];
        }
      }
      if (!cancelled) {
        setCandidates(eligibleTransferAgentCandidates(members, queueMemberIds, currentAssigneeId));
        setLoadingCandidates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, members, currentQueueId, currentAssigneeId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loadingCandidates ? (
          <div className="flex justify-center py-4"><Loader2 className="size-4 animate-spin" /></div>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noEligibleAgents')}</p>
        ) : (
          <div className="space-y-2">
            <Label>{t('agentLabel')}</Label>
            <Select value={agentUserId} onValueChange={(v) => setAgentUserId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('agentPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={() => onSubmit(agentUserId)} disabled={!agentUserId || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseTicketDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (finalize: boolean, closeReason: string) => void;
}) {
  const t = useTranslations('Tickets.closeDialog');
  const [reason, setReason] = useState('');

  // Reset the reason when the dialog closes — legitimate prop-driven
  // sync, same pattern as pipeline-settings.tsx/deal-form.tsx.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setReason('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="close-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="close-reason"
            placeholder={t('reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={submitting}
          />
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} className="sm:mr-auto">
            {t('cancel')}
          </Button>
          <Button variant="outline" onClick={() => onSubmit(false, reason)} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('closeButton')}
          </Button>
          <Button onClick={() => onSubmit(true, reason)} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('finalizeButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
