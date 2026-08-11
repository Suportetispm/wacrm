// ============================================================
// Pure, framework-free helpers for the /tickets UI (6E.4). Extracted
// from the components for the same reason as
// src/lib/platform/users-ui.ts — this repo has no
// @testing-library/react / jsdom setup, so anything needing render()
// can't be covered directly; the actual decision logic lives here,
// imported by the components, so the tests exercise the real code
// path instead of a parallel reimplementation.
//
// "Operational status" (Na fila / Em atendimento / Aguardando
// cliente / Encerrado / Finalizado) is a UI-only concept — it is
// never written to the database as its own column. It's derived from
// tickets.status + tickets.assigned_agent_id (always authoritative
// for 4 of the 5 states) and conversations.status (consulted only to
// split 'closed' into "Encerrado" vs "Finalizado" — see
// supabase/migrations/049_ticket_operations.sql's close_ticket(),
// which is the only writer of that split, in the same transaction as
// tickets.status='closed').
// ============================================================

import type { AccountRole } from '@/lib/auth/roles'
import type { ConversationStatus, TicketStatus } from '@/types'

export type OperationalStatus =
  | 'in_queue'
  | 'in_progress'
  | 'waiting_customer'
  | 'closed'
  | 'finalized'

export const OPERATIONAL_STATUSES: readonly OperationalStatus[] = [
  'in_queue',
  'in_progress',
  'waiting_customer',
  'closed',
  'finalized',
]

export interface TicketStatusInput {
  status: TicketStatus
  assigned_agent_id: string | null
  conversation_status?: ConversationStatus | null
}

/**
 * Derives the 5-state operational status shown in the UI. `closed`
 * defaults to "Encerrado" (never "Finalizado") whenever
 * conversation_status is missing/stale/anything other than exactly
 * 'finalized' — the safer, more conservative label when the two
 * fields haven't been read together for some reason.
 */
export function deriveOperationalStatus(t: TicketStatusInput): OperationalStatus {
  if (t.status === 'closed') {
    return t.conversation_status === 'finalized' ? 'finalized' : 'closed'
  }
  if (t.status === 'pending') return 'waiting_customer'
  // t.status === 'open'
  return t.assigned_agent_id ? 'in_progress' : 'in_queue'
}

/** The `status` query param GET /api/tickets should be called with
 *  for a given operational-status filter tab. `null` means "don't
 *  filter" (send no `status` param). 'in_queue'/'in_progress' both
 *  map to the same server-side 'open' — the split between them (and
 *  'closed' vs 'finalized') has no server-side filter today (no
 *  schema change for it, see 6E.1/6E.4 audits), so the component
 *  applies `matchesOperationalStatusFilter` client-side on top of
 *  this coarser server fetch. */
export function ticketStatusParamForFilter(filter: OperationalStatus | 'all'): TicketStatus | null {
  switch (filter) {
    case 'all':
      return null
    case 'in_queue':
    case 'in_progress':
      return 'open'
    case 'waiting_customer':
      return 'pending'
    case 'closed':
    case 'finalized':
      return 'closed'
  }
}

/** Client-side refinement on top of the server's coarser `status`
 *  fetch — see ticketStatusParamForFilter's doc comment. */
export function matchesOperationalStatusFilter(
  t: TicketStatusInput,
  filter: OperationalStatus | 'all',
): boolean {
  if (filter === 'all') return true
  return deriveOperationalStatus(t) === filter
}

export interface TicketActionState {
  claim: boolean
  transferQueue: boolean
  transferAgent: boolean
  waitCustomer: boolean
  resume: boolean
  close: boolean
}

/** Ticket-state-only availability — see visibleTicketActions() for
 *  the version that also accounts for the viewer's role/identity. */
export function ticketActionAvailability(
  t: TicketStatusInput & { queue_id: string | null },
): TicketActionState {
  const isClosed = t.status === 'closed'
  return {
    claim: t.status === 'open' && !t.assigned_agent_id && Boolean(t.queue_id),
    transferQueue: !isClosed,
    transferAgent: !isClosed,
    waitCustomer: t.status === 'open' && Boolean(t.assigned_agent_id),
    resume: t.status === 'pending',
    close: !isClosed,
  }
}

export interface TicketActionViewer {
  isAdminOrOwner: boolean
  currentUserId: string | null
}

/**
 * Combines ticket-state availability with the viewer's role/identity
 * to decide which action buttons actually render. This is a UX
 * narrowing on top of what the API/RPC would actually accept — e.g. a
 * queue-member agent who isn't the current assignee CAN transfer a
 * ticket via the RPC, but this hides that button rather than adding
 * an extra fetch just to compute visibility; the API remains the real
 * authority regardless of what the UI shows (see PARTE J of the
 * report). `claim` is deliberately never role-gated here — any
 * account member sees it whenever the ticket-state allows it; queue
 * membership (the actual remaining constraint) is enforced by
 * claim_ticket itself.
 */
export function visibleTicketActions(
  t: TicketStatusInput & { queue_id: string | null },
  viewer: TicketActionViewer,
): TicketActionState {
  const state = ticketActionAvailability(t)
  const isAssignee = viewer.currentUserId !== null && t.assigned_agent_id === viewer.currentUserId
  const canAct = viewer.isAdminOrOwner || isAssignee
  return {
    claim: state.claim,
    transferQueue: state.transferQueue && canAct,
    transferAgent: state.transferAgent && canAct,
    waitCustomer: state.waitCustomer && canAct,
    resume: state.resume && canAct,
    close: state.close && canAct,
  }
}

/** POST /api/tickets/[id]/close body from the close-dialog form
 *  state. Empty/whitespace-only reason becomes null — mirrors what
 *  close_ticket() itself does server-side (NULLIF(btrim(...), '')),
 *  just so the client doesn't send a misleading empty string. */
export function buildCloseTicketPayload(
  finalize: boolean,
  closeReason: string,
): { finalize: boolean; close_reason: string | null } {
  const trimmed = closeReason.trim()
  return { finalize, close_reason: trimmed ? trimmed : null }
}

export interface TicketActionErrorInfo {
  /** i18n key (under `Tickets`) for a distinct, translated, friendly
   *  message. `null` means: show `detail` instead — already a safe,
   *  hand-authored string from the RPC/API layer (see 6E.3's route
   *  tests, which pin that these never leak ids/internals). */
  translatedKey: 'errorAlreadyClaimed' | 'errorRateLimited' | 'errorForbidden' | 'errorGeneric' | null
  detail: string | null
}

/**
 * Classifies a failed ticket-action response into what to show the
 * operator. 409 (claim race lost / no-op transfer) gets a translated,
 * friendlier message than the raw server text; 429 gets a translated
 * "slow down" message; 400s show the server's own message as-is
 * (already curated/safe — never SQL/stack/ids, per 6E.3's tests);
 * 403/anything else collapses to a generic translated message.
 */
export function classifyTicketActionError(
  status: number,
  body: { error?: unknown } | null,
): TicketActionErrorInfo {
  const serverMessage = typeof body?.error === 'string' ? body.error : null

  if (status === 409) return { translatedKey: 'errorAlreadyClaimed', detail: null }
  if (status === 429) return { translatedKey: 'errorRateLimited', detail: null }
  if (status === 400) return { translatedKey: null, detail: serverMessage }
  if (status === 403) return { translatedKey: 'errorForbidden', detail: null }
  return { translatedKey: 'errorGeneric', detail: null }
}

/** Role check shared by the list/detail pages — 'owner' and 'admin'
 *  get the same ticket-management privileges throughout this module
 *  (mirrors the RPCs' own v_is_admin := v_caller_role IN ('owner',
 *  'admin') in migration 049). */
export function isAdminOrOwner(role: AccountRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
