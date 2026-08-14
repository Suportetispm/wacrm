'use client';

import { useCallback, useEffect, useState, use as usePromise } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import type {
  AccountMember,
  InternalCompany,
  InternalTeam,
  InternalTicket,
  InternalTicketComment,
  InternalTicketEvent,
  InternalTicketEventType,
  InternalTicketStage,
  InternalTicketStatus,
  InternalTicketType,
} from '@/types';

const NONE_VALUE = '__none__';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface EditState {
  title: string;
  description: string;
  type_id: string;
  status_id: string;
  stage_id: string;
  team_id: string;
  internal_company_id: string;
  assigned_user_id: string;
}

function toEditState(ticket: InternalTicket): EditState {
  return {
    title: ticket.title,
    description: ticket.description ?? '',
    type_id: ticket.type_id,
    status_id: ticket.status_id,
    stage_id: ticket.stage_id ?? '',
    team_id: ticket.team_id ?? '',
    internal_company_id: ticket.internal_company_id ?? '',
    assigned_user_id: ticket.assigned_user_id ?? '',
  };
}

export default function InternalTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const t = useTranslations('InternalTickets');
  const td = useTranslations('InternalTickets.detail');
  const tc = useTranslations('InternalTickets.comments');
  const te = useTranslations('InternalTickets.events');

  const [ticket, setTicket] = useState<InternalTicket | null>(null);
  const [events, setEvents] = useState<InternalTicketEvent[]>([]);
  const [comments, setComments] = useState<InternalTicketComment[]>([]);
  const [types, setTypes] = useState<InternalTicketType[]>([]);
  const [statuses, setStatuses] = useState<InternalTicketStatus[]>([]);
  const [stages, setStages] = useState<InternalTicketStage[]>([]);
  const [teams, setTeams] = useState<InternalTeam[]>([]);
  const [companies, setCompanies] = useState<InternalCompany[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [postingComment, setPostingComment] = useState(false);

  const EVENT_LABEL: Record<InternalTicketEventType, string> = {
    created: te('created'),
    title_changed: te('titleChanged'),
    description_changed: te('descriptionChanged'),
    type_changed: te('typeChanged'),
    status_changed: te('statusChanged'),
    stage_changed: te('stageChanged'),
    team_changed: te('teamChanged'),
    assignee_changed: te('assigneeChanged'),
    company_changed: te('companyChanged'),
    scheduled_at_changed: te('scheduledAtChanged'),
    comment_added: te('commentAdded'),
    completed: te('completed'),
    cancelled: te('cancelled'),
  };

  const loadTicket = useCallback(async () => {
    try {
      const res = await fetch(`/api/internal-tickets/${id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? td('loadFailed'));
        return;
      }
      setTicket(data.ticket as InternalTicket);
      setEvents((data.events as InternalTicketEvent[]) ?? []);
    } catch {
      toast.error(td('loadFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/internal-tickets/${id}/comments`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setComments((data.comments as InternalTicketComment[]) ?? []);
    } catch {
      // best-effort — comments failing to load shouldn't block the rest of the page
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadTicket(), loadComments()]).finally(() => setLoading(false));
  }, [loadTicket, loadComments]);

  useEffect(() => {
    fetch('/api/internal-tickets/types', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setTypes((d.types as InternalTicketType[]) ?? []))
      .catch(() => {});
    fetch('/api/internal-tickets/statuses', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setStatuses((d.statuses as InternalTicketStatus[]) ?? []))
      .catch(() => {});
    fetch('/api/internal-tickets/stages', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setStages((d.stages as InternalTicketStage[]) ?? []))
      .catch(() => {});
    fetch('/api/internal-tickets/teams', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setTeams((d.teams as InternalTeam[]) ?? []))
      .catch(() => {});
    fetch('/api/internal-tickets/companies', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setCompanies((d.companies as InternalCompany[]) ?? []))
      .catch(() => {});
    fetchAccountMembers().then(setMembers);
  }, []);

  const typeById = new Map(types.map((x) => [x.id, x]));
  const statusById = new Map(statuses.map((x) => [x.id, x]));
  const stageById = new Map(stages.map((x) => [x.id, x]));
  const teamById = new Map(teams.map((x) => [x.id, x]));
  const companyById = new Map(companies.map((x) => [x.id, x]));
  const memberById = new Map(members.map((m) => [m.user_id, m]));

  function eventValueLabel(eventType: InternalTicketEventType, raw: string | null): string {
    if (raw === null) return t('none');
    switch (eventType) {
      case 'type_changed':
        return typeById.get(raw)?.name ?? raw;
      case 'status_changed':
        return statusById.get(raw)?.name ?? raw;
      case 'stage_changed':
        return stageById.get(raw)?.name ?? raw;
      case 'team_changed':
        return teamById.get(raw)?.name ?? raw;
      case 'company_changed':
        return companyById.get(raw)?.name ?? raw;
      case 'assignee_changed': {
        const m = memberById.get(raw);
        return m ? memberLabel(m) : raw;
      }
      default:
        return raw;
    }
  }

  function startEditing() {
    if (!ticket) return;
    setEdit(toEditState(ticket));
    setEditing(true);
  }

  async function saveEdit() {
    if (!ticket || !edit) return;

    // Client-side diff first — only send fields that actually changed.
    // The RPC already safely no-ops an unchanged field, but there's no
    // reason to ask the server to re-derive that when we already know
    // it here.
    const before = toEditState(ticket);
    const changes: Record<string, string | null> = {};
    if (edit.title !== before.title) changes.title = edit.title;
    if (edit.description !== before.description) changes.description = edit.description || null;
    if (edit.type_id !== before.type_id) changes.type_id = edit.type_id;
    if (edit.status_id !== before.status_id) changes.status_id = edit.status_id;
    if (edit.stage_id !== before.stage_id) changes.stage_id = edit.stage_id || null;
    if (edit.team_id !== before.team_id) changes.team_id = edit.team_id || null;
    if (edit.internal_company_id !== before.internal_company_id) changes.internal_company_id = edit.internal_company_id || null;
    if (edit.assigned_user_id !== before.assigned_user_id) changes.assigned_user_id = edit.assigned_user_id || null;

    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/internal-tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 403 ? td('forbidden') : (data.error ?? td('saveFailed')));
        return;
      }
      toast.success(td('saved'));
      setEditing(false);
      await loadTicket();
    } finally {
      setSaving(false);
    }
  }

  async function submitComment() {
    if (!commentBody.trim()) return;
    setPostingComment(true);
    try {
      const res = await fetch(`/api/internal-tickets/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? tc('postFailed'));
        return;
      }
      setCommentBody('');
      await Promise.all([loadComments(), loadTicket()]);
    } finally {
      setPostingComment(false);
    }
  }

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

  const type = typeById.get(ticket.type_id);
  const status = statusById.get(ticket.status_id);
  const stage = ticket.stage_id ? stageById.get(ticket.stage_id) : null;
  const team = ticket.team_id ? teamById.get(ticket.team_id) : null;
  const company = ticket.internal_company_id ? companyById.get(ticket.internal_company_id) : null;
  const assignee = ticket.assigned_user_id ? memberById.get(ticket.assigned_user_id) : null;
  const creator = memberById.get(ticket.created_by);

  return (
    <div>
      <Link href="/internal-tickets" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {td('backToList')}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {td('titleWithCode', { code: ticket.internal_code })}
        </h1>
        {status && (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
            {status.name}
          </span>
        )}
        {stage && <Badge variant="outline">{stage.name}</Badge>}
      </div>
      <p className="mt-1 text-lg text-foreground">{ticket.title}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{td('descriptionTitle')}</CardTitle>
              {!editing && (
                <Button size="sm" variant="outline" onClick={startEditing}>
                  {td('editButton')}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {editing && edit ? (
                <EditForm
                  edit={edit}
                  setEdit={setEdit}
                  types={types.filter((x) => x.is_active || x.id === ticket.type_id)}
                  statuses={statuses.filter((x) => x.is_active || x.id === ticket.status_id)}
                  stages={stages.filter((x) => x.is_active || x.id === ticket.stage_id)}
                  teams={teams.filter((x) => x.is_active || x.id === ticket.team_id)}
                  companies={companies.filter((x) => x.is_active || x.id === ticket.internal_company_id)}
                  members={members.filter((m) => m.is_active || m.user_id === ticket.assigned_user_id)}
                  saving={saving}
                  onCancel={() => setEditing(false)}
                  onSave={saveEdit}
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {ticket.description || <span className="text-muted-foreground">{td('noDescription')}</span>}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tc('title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tc('empty')}</p>
              ) : (
                <ul className="space-y-3">
                  {comments.map((c) => {
                    const author = memberById.get(c.author_id);
                    return (
                      <li key={c.id} className="rounded-md border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">{author ? memberLabel(author) : '—'}</p>
                          <p className="text-xs text-muted-foreground">{fmtDate(c.created_at)}</p>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="space-y-2 pt-2">
                <Textarea
                  placeholder={tc('placeholder')}
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  disabled={postingComment}
                />
                <Button size="sm" onClick={submitComment} disabled={!commentBody.trim() || postingComment}>
                  {postingComment ? <Loader2 className="size-4 animate-spin" /> : null}
                  {tc('submit')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{te('title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{te('empty')}</p>
              ) : (
                <ol className="space-y-4">
                  {events.map((event) => {
                    const fromLabel = eventValueLabel(event.event_type, event.from_value);
                    const toLabel = eventValueLabel(event.event_type, event.to_value);
                    const showDiff =
                      event.event_type !== 'description_changed' &&
                      event.event_type !== 'comment_added' &&
                      (event.from_value !== null || event.to_value !== null);
                    return (
                      <li key={event.id} className="flex gap-3">
                        <div className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{EVENT_LABEL[event.event_type] ?? event.event_type}</p>
                          {showDiff && (
                            <p className="text-xs text-muted-foreground">
                              {event.from_value !== null ? `${fromLabel} → ` : ''}
                              {toLabel}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">{fmtDate(event.created_at)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">{td('infoTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">{td('typeLabel')}</p>
              <p>{type?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('companyLabel')}</p>
              <p>{company?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('teamLabel')}</p>
              <p>{team?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('assigneeLabel')}</p>
              <p>{assignee ? memberLabel(assignee) : <span className="text-muted-foreground">{t('unassigned')}</span>}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('creatorLabel')}</p>
              <p>{creator ? memberLabel(creator) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('createdLabel')}</p>
              <p>{fmtDate(ticket.created_at)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{td('updatedLabel')}</p>
              <p>{fmtDate(ticket.updated_at)}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EditForm({
  edit,
  setEdit,
  types,
  statuses,
  stages,
  teams,
  companies,
  members,
  saving,
  onCancel,
  onSave,
}: {
  edit: EditState;
  setEdit: (e: EditState) => void;
  types: InternalTicketType[];
  statuses: InternalTicketStatus[];
  stages: InternalTicketStage[];
  teams: InternalTeam[];
  companies: InternalCompany[];
  members: AccountMember[];
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const td = useTranslations('InternalTickets.detail');
  const tn = useTranslations('InternalTickets.newDialog');
  const t = useTranslations('InternalTickets');

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="edit-title">{tn('titleLabel')}</Label>
        <Input
          id="edit-title"
          value={edit.title}
          onChange={(e) => setEdit({ ...edit, title: e.target.value })}
          maxLength={120}
        />
      </div>
      <div>
        <Label htmlFor="edit-description">{tn('descriptionLabel')}</Label>
        <Textarea
          id="edit-description"
          value={edit.description}
          onChange={(e) => setEdit({ ...edit, description: e.target.value })}
        />
      </div>
      <div>
        <Label>{tn('typeLabel')}</Label>
        <Select value={edit.type_id} onValueChange={(v) => setEdit({ ...edit, type_id: v ?? edit.type_id })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {types.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>{tn('statusLabel')}</Label>
        <Select value={edit.status_id} onValueChange={(v) => setEdit({ ...edit, status_id: v ?? edit.status_id })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {statuses.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>{tn('stageLabel')}</Label>
        <Select
          value={edit.stage_id || NONE_VALUE}
          onValueChange={(v) => setEdit({ ...edit, stage_id: v === NONE_VALUE ? '' : (v ?? '') })}
        >
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t('none')}</SelectItem>
            {stages.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>{tn('teamLabel')}</Label>
        <Select
          value={edit.team_id || NONE_VALUE}
          onValueChange={(v) => setEdit({ ...edit, team_id: v === NONE_VALUE ? '' : (v ?? '') })}
        >
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t('none')}</SelectItem>
            {teams.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>{tn('assigneeLabel')}</Label>
        <Select
          value={edit.assigned_user_id || NONE_VALUE}
          onValueChange={(v) => setEdit({ ...edit, assigned_user_id: v === NONE_VALUE ? '' : (v ?? '') })}
        >
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t('unassigned')}</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>{memberLabel(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>{tn('companyLabel')}</Label>
        <Select
          value={edit.internal_company_id || NONE_VALUE}
          onValueChange={(v) => setEdit({ ...edit, internal_company_id: v === NONE_VALUE ? '' : (v ?? '') })}
        >
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t('none')}</SelectItem>
            {companies.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {td('cancelEdit')}
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || !edit.title.trim()}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {td('saveButton')}
        </Button>
      </div>
    </div>
  );
}
