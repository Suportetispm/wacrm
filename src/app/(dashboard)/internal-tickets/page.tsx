'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ClipboardList, Loader2, Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
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
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import type {
  AccountMember,
  InternalCompany,
  InternalTeam,
  InternalTicket,
  InternalTicketStage,
  InternalTicketStatus,
  InternalTicketType,
} from '@/types';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** All 5 catalogs + account members, shared by the list and the "new
 *  ticket" dialog. Fetched once per page mount — each already
 *  RLS-scoped/account-scoped by its own route, so no extra tenancy
 *  work is needed here. */
function useInternalTicketCatalogs() {
  const [types, setTypes] = useState<InternalTicketType[]>([]);
  const [statuses, setStatuses] = useState<InternalTicketStatus[]>([]);
  const [stages, setStages] = useState<InternalTicketStage[]>([]);
  const [teams, setTeams] = useState<InternalTeam[]>([]);
  const [companies, setCompanies] = useState<InternalCompany[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);

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

  return { types, statuses, stages, teams, companies, members };
}

export default function InternalTicketsPage() {
  const t = useTranslations('InternalTickets');
  const router = useRouter();
  const catalogs = useInternalTicketCatalogs();

  const [tickets, setTickets] = useState<InternalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [typeId, setTypeId] = useState('all');
  const [statusId, setStatusId] = useState('all');
  const [stageId, setStageId] = useState('all');
  const [teamId, setTeamId] = useState('all');
  const [assigneeId, setAssigneeId] = useState('all');
  const [companyId, setCompanyId] = useState('all');
  const [openDialog, setOpenDialog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (typeId !== 'all') params.set('type_id', typeId);
      if (statusId !== 'all') params.set('status_id', statusId);
      if (stageId !== 'all') params.set('stage_id', stageId);
      if (teamId !== 'all') params.set('team_id', teamId);
      if (assigneeId !== 'all') params.set('assigned_user_id', assigneeId);
      if (companyId !== 'all') params.set('internal_company_id', companyId);

      const res = await fetch(`/api/internal-tickets?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setTickets((data.tickets as InternalTicket[]) ?? []);
      } else {
        toast.error(data.error ?? t('loadFailed'));
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, typeId, statusId, stageId, teamId, assigneeId, companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeById = new Map(catalogs.types.map((x) => [x.id, x]));
  const statusById = new Map(catalogs.statuses.map((x) => [x.id, x]));
  const stageById = new Map(catalogs.stages.map((x) => [x.id, x]));
  const teamById = new Map(catalogs.teams.map((x) => [x.id, x]));
  const companyById = new Map(catalogs.companies.map((x) => [x.id, x]));
  const memberById = new Map(catalogs.members.map((m) => [m.user_id, m]));

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('pageTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('pageDesc')}</p>
        </div>
        <RequireRole min="agent">
          <Button size="sm" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" />
            {t('newTicket')}
          </Button>
        </RequireRole>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-56 pl-8"
          />
        </div>
        <Select value={typeId} onValueChange={(v) => setTypeId(v ?? 'all')}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('typeFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allTypes')}</SelectItem>
            {catalogs.types.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusId} onValueChange={(v) => setStatusId(v ?? 'all')}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('statusFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allStatuses')}</SelectItem>
            {catalogs.statuses.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={stageId} onValueChange={(v) => setStageId(v ?? 'all')}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('stageFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allStages')}</SelectItem>
            {catalogs.stages.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={teamId} onValueChange={(v) => setTeamId(v ?? 'all')}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('teamFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allTeams')}</SelectItem>
            {catalogs.teams.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assigneeId} onValueChange={(v) => setAssigneeId(v ?? 'all')}>
          <SelectTrigger className="w-40"><SelectValue placeholder={t('assigneeFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allAssignees')}</SelectItem>
            {catalogs.members.map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>{memberLabel(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={companyId} onValueChange={(v) => setCompanyId(v ?? 'all')}>
          <SelectTrigger className="w-40"><SelectValue placeholder={t('companyFilterPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allCompanies')}</SelectItem>
            {catalogs.companies.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <ClipboardList className="mx-auto mb-2 size-6 opacity-50" />
            {t('empty')}
          </div>
        ) : (
          <>
            {/* Desktop: table. */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colCode')}</TableHead>
                    <TableHead>{t('colTitle')}</TableHead>
                    <TableHead>{t('colType')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead>{t('colStage')}</TableHead>
                    <TableHead>{t('colTeam')}</TableHead>
                    <TableHead>{t('colAssignee')}</TableHead>
                    <TableHead>{t('colCompany')}</TableHead>
                    <TableHead>{t('colCreator')}</TableHead>
                    <TableHead>{t('colUpdatedAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map((ticket) => {
                    const type = typeById.get(ticket.type_id);
                    const status = statusById.get(ticket.status_id);
                    const stage = ticket.stage_id ? stageById.get(ticket.stage_id) : null;
                    const team = ticket.team_id ? teamById.get(ticket.team_id) : null;
                    const company = ticket.internal_company_id ? companyById.get(ticket.internal_company_id) : null;
                    const assignee = ticket.assigned_user_id ? memberById.get(ticket.assigned_user_id) : null;
                    const creator = memberById.get(ticket.created_by);
                    return (
                      <TableRow key={ticket.id}>
                        <TableCell>
                          <Link href={`/internal-tickets/${ticket.id}`} className="font-medium hover:underline">
                            #{ticket.internal_code}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-64 truncate">{ticket.title}</TableCell>
                        <TableCell className="text-muted-foreground">{type?.name ?? '—'}</TableCell>
                        <TableCell>
                          {status ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
                              {status.name}
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell>{stage ? <Badge variant="outline">{stage.name}</Badge> : '—'}</TableCell>
                        <TableCell>{team ? <Badge variant="outline">{team.name}</Badge> : '—'}</TableCell>
                        <TableCell>
                          {assignee ? memberLabel(assignee) : <span className="text-muted-foreground">{t('unassigned')}</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{company?.name ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{creator ? memberLabel(creator) : '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(ticket.updated_at)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: cards. */}
            <div className="flex flex-col gap-3 md:hidden">
              {tickets.map((ticket) => {
                const status = statusById.get(ticket.status_id);
                const assignee = ticket.assigned_user_id ? memberById.get(ticket.assigned_user_id) : null;
                return (
                  <Link
                    key={ticket.id}
                    href={`/internal-tickets/${ticket.id}`}
                    className="block rounded-lg border border-border p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">#{ticket.internal_code} · {ticket.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {assignee ? memberLabel(assignee) : t('unassigned')}
                        </p>
                      </div>
                      {status && (
                        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
                          <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
                          {status.name}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{fmtDate(ticket.updated_at)}</div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </div>

      <NewInternalTicketDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        types={catalogs.types}
        statuses={catalogs.statuses}
        stages={catalogs.stages}
        teams={catalogs.teams}
        companies={catalogs.companies}
        members={catalogs.members}
        onCreated={(id) => {
          setOpenDialog(false);
          router.push(`/internal-tickets/${id}`);
        }}
      />
    </div>
  );
}

function NewInternalTicketDialog({
  open,
  onOpenChange,
  types,
  statuses,
  stages,
  teams,
  companies,
  members,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: InternalTicketType[];
  statuses: InternalTicketStatus[];
  stages: InternalTicketStage[];
  teams: InternalTeam[];
  companies: InternalCompany[];
  members: AccountMember[];
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('InternalTickets.newDialog');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [typeId, setTypeId] = useState('');
  const [statusId, setStatusId] = useState('');
  const [stageId, setStageId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setDescription('');
      setTypeId('');
      setStatusId('');
      setStageId('');
      setTeamId('');
      setAssigneeId('');
      setCompanyId('');
    }
  }, [open]);

  // Only active catalog items are offered for a NEW ticket — an
  // inactive one might still be referenced by existing tickets, but
  // never chosen for a fresh one.
  const activeTypes = types.filter((x) => x.is_active);
  const activeStatuses = statuses.filter((x) => x.is_active);
  const activeStages = stages.filter((x) => x.is_active);
  const activeTeams = teams.filter((x) => x.is_active);
  const activeCompanies = companies.filter((x) => x.is_active);

  const submit = useCallback(async () => {
    if (!title.trim() || !typeId) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          type_id: typeId,
          status_id: statusId || null,
          stage_id: stageId || null,
          team_id: teamId || null,
          assigned_user_id: assigneeId || null,
          internal_company_id: companyId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('createFailed'));
        return;
      }
      toast.success(t('created'));
      onCreated(data.ticket.id);
    } finally {
      setSubmitting(false);
    }
  }, [title, description, typeId, statusId, stageId, teamId, assigneeId, companyId, onCreated, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div>
            <Label htmlFor="int-ticket-title">{t('titleLabel')}</Label>
            <Input
              id="int-ticket-title"
              placeholder={t('titlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </div>

          <div>
            <Label htmlFor="int-ticket-description">{t('descriptionLabel')}</Label>
            <Textarea
              id="int-ticket-description"
              placeholder={t('descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <Label>{t('typeLabel')}</Label>
            <Select value={typeId} onValueChange={(v) => setTypeId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('typePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {activeTypes.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('statusLabel')}</Label>
            <Select value={statusId} onValueChange={(v) => setStatusId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('statusPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {activeStatuses.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('stageLabel')}</Label>
            <Select value={stageId} onValueChange={(v) => setStageId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('stagePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {activeStages.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('teamLabel')}</Label>
            <Select value={teamId} onValueChange={(v) => setTeamId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('teamPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {activeTeams.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('assigneeLabel')}</Label>
            <Select value={assigneeId} onValueChange={(v) => setAssigneeId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('assigneePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {members.filter((m) => m.is_active).map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>{memberLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('companyLabel')}</Label>
            <Select value={companyId} onValueChange={(v) => setCompanyId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('companyPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {activeCompanies.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={!title.trim() || !typeId || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
