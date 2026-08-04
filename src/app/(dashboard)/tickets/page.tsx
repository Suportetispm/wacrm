'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, Plus, Search, Ticket as TicketIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import type { Queue, Ticket, TicketPriority, TicketStatus } from '@/types';

const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  normal: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  high: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-500/15 text-red-600 dark:text-red-400',
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

export default function TicketsPage() {
  const t = useTranslations('Tickets');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<TicketStatus | 'all'>('open');
  const [queueId, setQueueId] = useState<string>('all');
  const [priority, setPriority] = useState<TicketPriority | 'all'>('all');
  const [q, setQ] = useState('');
  const [openDialog, setOpenDialog] = useState(false);

  const STATUS_TABS: { value: TicketStatus | 'all'; label: string }[] = [
    { value: 'open', label: t('statusOpen') },
    { value: 'pending', label: t('statusPending') },
    { value: 'closed', label: t('statusClosed') },
    { value: 'all', label: t('statusAll') },
  ];
  const PRIORITY_LABEL: Record<TicketPriority, string> = {
    low: t('priorityLow'),
    normal: t('priorityNormal'),
    high: t('priorityHigh'),
    urgent: t('priorityUrgent'),
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (queueId !== 'all') params.set('queue_id', queueId);
      if (priority !== 'all') params.set('priority', priority);
      if (q.trim()) params.set('q', q.trim());

      const res = await fetch(`/api/tickets?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setTickets((data.tickets as Ticket[]) ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, queueId, priority, q]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch('/api/queues', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setQueues((d.queues as Queue[]) ?? []))
      .catch(() => {});
  }, []);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('pageTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('pageDesc')}</p>
        </div>
        <RequireRole min="admin">
          <Button size="sm" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" />
            {t('newTicket')}
          </Button>
        </RequireRole>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <Button
            key={tab.value}
            variant={status === tab.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatus(tab.value)}
          >
            {tab.label}
          </Button>
        ))}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-56 pl-8"
            />
          </div>
          <Select value={queueId} onValueChange={(v) => setQueueId(v ?? 'all')}>
            <SelectTrigger className="w-40"><SelectValue placeholder={t('queueFilterPlaceholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allQueues')}</SelectItem>
              {queues.map((qu) => (
                <SelectItem key={qu.id} value={qu.id}>{qu.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={(v) => setPriority((v ?? 'all') as TicketPriority | 'all')}>
            <SelectTrigger className="w-32"><SelectValue placeholder={t('priorityFilterPlaceholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allPriorities')}</SelectItem>
              <SelectItem value="low">{PRIORITY_LABEL.low}</SelectItem>
              <SelectItem value="normal">{PRIORITY_LABEL.normal}</SelectItem>
              <SelectItem value="high">{PRIORITY_LABEL.high}</SelectItem>
              <SelectItem value="urgent">{PRIORITY_LABEL.urgent}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <TicketIcon className="mx-auto mb-2 size-6 opacity-50" />
            {t('empty')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colNumber')}</TableHead>
                <TableHead>{t('colContact')}</TableHead>
                <TableHead>{t('colQueue')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead>{t('colPriority')}</TableHead>
                <TableHead>{t('colOpened')}</TableHead>
                <TableHead>{t('colUpdated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((ticket) => (
                <TableRow key={ticket.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/tickets/${ticket.id}`} className="font-medium hover:underline">
                      #{ticket.ticket_number}
                    </Link>
                  </TableCell>
                  <TableCell>{ticket.contact?.name || ticket.contact?.phone || '—'}</TableCell>
                  <TableCell>
                    {ticket.queue ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ backgroundColor: ticket.queue.color }} />
                        {ticket.queue.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('untriaged')}</span>
                    )}
                  </TableCell>
                  <TableCell className="capitalize">
                    {ticket.status === 'open' ? t('statusOpen') : ticket.status === 'pending' ? t('statusPending') : t('statusClosed')}
                  </TableCell>
                  <TableCell>
                    <Badge className={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(ticket.opened_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(ticket.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <NewTicketDialog open={openDialog} onOpenChange={setOpenDialog} queues={queues} onCreated={load} />
    </div>
  );
}

interface ConversationHit {
  id: string;
  contact: { id: string; name: string | null; phone: string } | null;
}

function NewTicketDialog({
  open,
  onOpenChange,
  queues,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queues: Queue[];
  onCreated: () => void;
}) {
  const t = useTranslations('Tickets.newTicketDialog');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ConversationHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ConversationHit | null>(null);
  const [queueId, setQueueId] = useState<string>('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setResults([]);
      setSelected(null);
      setQueueId('');
      setPriority('normal');
    }
  }, [open]);

  // Debounced conversation search (by contact name/phone) — a
  // dedicated small endpoint rather than reusing /api/tickets's own
  // search, since that one filters EXISTING tickets and this dialog
  // needs conversations regardless of whether they have a ticket yet.
  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/tickets/conversations-search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setResults((data.conversations as ConversationHit[]) ?? []);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, search]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tickets/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: selected.id,
          queue_id: queueId || null,
          priority,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      toast.success(
        data.ticket.status === 'open'
          ? t('openedToast', { number: data.ticket.ticket_number })
          : t('alreadyActiveToast', { number: data.ticket.ticket_number }),
      );
      onOpenChange(false);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }, [selected, queueId, priority, onOpenChange, onCreated, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="ticket-conv-search">{t('conversationLabel')}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ticket-conv-search"
                placeholder={t('searchPlaceholder')}
                value={selected ? selected.contact?.name || selected.contact?.phone || selected.id : search}
                onChange={(e) => {
                  setSelected(null);
                  setSearch(e.target.value);
                }}
                className="pl-8"
              />
            </div>
            {!selected && search && (
              <div className="mt-1 max-h-40 overflow-y-auto rounded-md border">
                {searching ? (
                  <div className="flex justify-center p-2"><Loader2 className="size-4 animate-spin" /></div>
                ) : results.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">{t('noResults')}</p>
                ) : (
                  results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setSelected(r);
                        setSearch('');
                      }}
                      className="block w-full px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      {r.contact?.name || r.contact?.phone || r.id}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div>
            <Label>{t('queueLabel')}</Label>
            <Select value={queueId} onValueChange={(v) => setQueueId(v ?? '')}>
              <SelectTrigger><SelectValue placeholder={t('queuePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {queues.map((qu) => (
                  <SelectItem key={qu.id} value={qu.id}>{qu.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('priorityLabel')}</Label>
            <Select value={priority} onValueChange={(v) => setPriority((v ?? 'normal') as TicketPriority)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t('priorityLow')}</SelectItem>
                <SelectItem value="normal">{t('priorityNormal')}</SelectItem>
                <SelectItem value="high">{t('priorityHigh')}</SelectItem>
                <SelectItem value="urgent">{t('priorityUrgent')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={!selected || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
