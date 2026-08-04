'use client';

import { useEffect, useState, use as usePromise } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Ticket, TicketEvent, TicketPriority } from '@/types';

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

/**
 * Read-only ticket detail + timeline. No status/priority/assignment
 * editing here — this etapa deliberately ships no client UPDATE path
 * for `tickets` (see migration 040's comment on why: RLS can't limit
 * which COLUMNS a caller touches, only which rows — mutations are
 * deferred to future SECURITY DEFINER functions that also write the
 * matching ticket_events row, mirroring open_ticket_for_conversation).
 */
export default function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const t = useTranslations('Tickets');
  const td = useTranslations('Tickets.detail');
  const te = useTranslations('Tickets.events');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const PRIORITY_LABEL: Record<TicketPriority, string> = {
    low: t('priorityLow'),
    normal: t('priorityNormal'),
    high: t('priorityHigh'),
    urgent: t('priorityUrgent'),
  };
  const STATUS_LABEL: Record<Ticket['status'], string> = {
    open: t('statusOpen'),
    pending: t('statusPending'),
    closed: t('statusClosed'),
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/tickets/${id}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
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
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  return (
    <div>
      <Link href="/tickets" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {td('backToTickets')}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{td('titleWithNumber', { number: ticket.ticket_number })}</h1>
        <Badge variant="secondary">{STATUS_LABEL[ticket.status]}</Badge>
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{td('detailsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">{td('contactLabel')}</p>
                <p className="font-medium">{ticket.contact?.name || ticket.contact?.phone || '—'}</p>
              </div>
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
                <p className="text-xs text-muted-foreground">{td('openedLabel')}</p>
                <p>{fmtDate(ticket.opened_at)}</p>
              </div>
              {ticket.closed_at && (
                <div>
                  <p className="text-xs text-muted-foreground">{td('closedLabel')}</p>
                  <p>{fmtDate(ticket.closed_at)}</p>
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
    </div>
  );
}
