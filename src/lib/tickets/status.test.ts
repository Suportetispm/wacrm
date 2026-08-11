import { describe, expect, it } from 'vitest'

import {
  buildCloseTicketPayload,
  classifyTicketActionError,
  deriveOperationalStatus,
  isAdminOrOwner,
  matchesOperationalStatusFilter,
  ticketActionAvailability,
  ticketStatusParamForFilter,
  visibleTicketActions,
} from './status'

describe('deriveOperationalStatus', () => {
  it('open + no assignee -> in_queue (Na fila)', () => {
    expect(deriveOperationalStatus({ status: 'open', assigned_agent_id: null })).toBe('in_queue')
  })

  it('open + assignee -> in_progress (Em atendimento)', () => {
    expect(deriveOperationalStatus({ status: 'open', assigned_agent_id: 'user-1' })).toBe('in_progress')
  })

  it("pending -> waiting_customer (Aguardando cliente), regardless of assignee", () => {
    expect(deriveOperationalStatus({ status: 'pending', assigned_agent_id: 'user-1' })).toBe('waiting_customer')
  })

  it("closed + conversation_status='finalized' -> finalized", () => {
    expect(
      deriveOperationalStatus({ status: 'closed', assigned_agent_id: null, conversation_status: 'finalized' }),
    ).toBe('finalized')
  })

  it("closed + conversation_status='closed' -> closed", () => {
    expect(
      deriveOperationalStatus({ status: 'closed', assigned_agent_id: null, conversation_status: 'closed' }),
    ).toBe('closed')
  })

  it('closed + missing/unknown conversation_status defaults to closed (never finalized)', () => {
    expect(deriveOperationalStatus({ status: 'closed', assigned_agent_id: null })).toBe('closed')
    expect(
      deriveOperationalStatus({ status: 'closed', assigned_agent_id: null, conversation_status: null }),
    ).toBe('closed')
    expect(
      deriveOperationalStatus({ status: 'closed', assigned_agent_id: null, conversation_status: 'pending' }),
    ).toBe('closed')
  })
})

describe('ticketStatusParamForFilter', () => {
  it('maps in_queue/in_progress to the server open status', () => {
    expect(ticketStatusParamForFilter('in_queue')).toBe('open')
    expect(ticketStatusParamForFilter('in_progress')).toBe('open')
  })

  it('maps waiting_customer to pending', () => {
    expect(ticketStatusParamForFilter('waiting_customer')).toBe('pending')
  })

  it('maps closed/finalized to the server closed status', () => {
    expect(ticketStatusParamForFilter('closed')).toBe('closed')
    expect(ticketStatusParamForFilter('finalized')).toBe('closed')
  })

  it("'all' sends no status param", () => {
    expect(ticketStatusParamForFilter('all')).toBeNull()
  })
})

describe('matchesOperationalStatusFilter', () => {
  it("'all' matches everything", () => {
    expect(matchesOperationalStatusFilter({ status: 'open', assigned_agent_id: null }, 'all')).toBe(true)
    expect(matchesOperationalStatusFilter({ status: 'closed', assigned_agent_id: null }, 'all')).toBe(true)
  })

  it('splits open tickets between in_queue and in_progress client-side', () => {
    const unassigned = { status: 'open' as const, assigned_agent_id: null }
    const assigned = { status: 'open' as const, assigned_agent_id: 'user-1' }
    expect(matchesOperationalStatusFilter(unassigned, 'in_queue')).toBe(true)
    expect(matchesOperationalStatusFilter(unassigned, 'in_progress')).toBe(false)
    expect(matchesOperationalStatusFilter(assigned, 'in_progress')).toBe(true)
    expect(matchesOperationalStatusFilter(assigned, 'in_queue')).toBe(false)
  })

  it('splits closed tickets between closed and finalized client-side', () => {
    const closed = { status: 'closed' as const, assigned_agent_id: null, conversation_status: 'closed' as const }
    const finalized = { status: 'closed' as const, assigned_agent_id: null, conversation_status: 'finalized' as const }
    expect(matchesOperationalStatusFilter(closed, 'closed')).toBe(true)
    expect(matchesOperationalStatusFilter(closed, 'finalized')).toBe(false)
    expect(matchesOperationalStatusFilter(finalized, 'finalized')).toBe(true)
    expect(matchesOperationalStatusFilter(finalized, 'closed')).toBe(false)
  })
})

describe('ticketActionAvailability', () => {
  it('claim: only open + unassigned + has a queue', () => {
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: null, queue_id: 'q1' }).claim).toBe(true)
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: 'u1', queue_id: 'q1' }).claim).toBe(false)
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: null, queue_id: null }).claim).toBe(false)
    expect(ticketActionAvailability({ status: 'pending', assigned_agent_id: null, queue_id: 'q1' }).claim).toBe(false)
  })

  it('transferQueue/transferAgent: available for anything not closed', () => {
    const open = ticketActionAvailability({ status: 'open', assigned_agent_id: null, queue_id: null })
    const pending = ticketActionAvailability({ status: 'pending', assigned_agent_id: 'u1', queue_id: null })
    const closed = ticketActionAvailability({ status: 'closed', assigned_agent_id: null, queue_id: null })
    expect(open.transferQueue).toBe(true)
    expect(open.transferAgent).toBe(true)
    expect(pending.transferQueue).toBe(true)
    expect(closed.transferQueue).toBe(false)
    expect(closed.transferAgent).toBe(false)
  })

  it('waitCustomer: only open + assigned', () => {
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: 'u1', queue_id: null }).waitCustomer).toBe(true)
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: null, queue_id: null }).waitCustomer).toBe(false)
    expect(ticketActionAvailability({ status: 'pending', assigned_agent_id: 'u1', queue_id: null }).waitCustomer).toBe(false)
  })

  it('resume: only pending', () => {
    expect(ticketActionAvailability({ status: 'pending', assigned_agent_id: 'u1', queue_id: null }).resume).toBe(true)
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: 'u1', queue_id: null }).resume).toBe(false)
  })

  it('close: available for anything not already closed', () => {
    expect(ticketActionAvailability({ status: 'open', assigned_agent_id: null, queue_id: null }).close).toBe(true)
    expect(ticketActionAvailability({ status: 'pending', assigned_agent_id: null, queue_id: null }).close).toBe(true)
    expect(ticketActionAvailability({ status: 'closed', assigned_agent_id: null, queue_id: null }).close).toBe(false)
  })
})

describe('visibleTicketActions', () => {
  const openUnassigned = { status: 'open' as const, assigned_agent_id: null, queue_id: 'q1' }
  const openAssignedToMe = { status: 'open' as const, assigned_agent_id: 'me', queue_id: 'q1' }
  const openAssignedToOther = { status: 'open' as const, assigned_agent_id: 'someone-else', queue_id: 'q1' }

  it('admin/owner sees every state-eligible action regardless of assignee', () => {
    const viewer = { isAdminOrOwner: true, currentUserId: 'me' }
    expect(visibleTicketActions(openAssignedToOther, viewer).transferAgent).toBe(true)
    expect(visibleTicketActions(openAssignedToOther, viewer).close).toBe(true)
  })

  it('a plain agent sees management actions only on tickets assigned to them', () => {
    const viewer = { isAdminOrOwner: false, currentUserId: 'me' }
    expect(visibleTicketActions(openAssignedToMe, viewer).transferAgent).toBe(true)
    expect(visibleTicketActions(openAssignedToMe, viewer).close).toBe(true)
    expect(visibleTicketActions(openAssignedToOther, viewer).transferAgent).toBe(false)
    expect(visibleTicketActions(openAssignedToOther, viewer).close).toBe(false)
  })

  it('claim is never role-gated — visible to any viewer when the ticket state allows it', () => {
    const agentViewer = { isAdminOrOwner: false, currentUserId: 'someone-not-assigned' }
    expect(visibleTicketActions(openUnassigned, agentViewer).claim).toBe(true)
  })

  it('an unauthenticated-looking viewer (currentUserId null) never counts as the assignee', () => {
    const viewer = { isAdminOrOwner: false, currentUserId: null }
    expect(visibleTicketActions(openAssignedToMe, viewer).transferAgent).toBe(false)
  })
})

describe('buildCloseTicketPayload', () => {
  it('trims the reason and passes finalize through', () => {
    expect(buildCloseTicketPayload(false, '  resolved  ')).toEqual({ finalize: false, close_reason: 'resolved' })
    expect(buildCloseTicketPayload(true, 'done')).toEqual({ finalize: true, close_reason: 'done' })
  })

  it('an empty/whitespace-only reason becomes null, never an empty string', () => {
    expect(buildCloseTicketPayload(false, '')).toEqual({ finalize: false, close_reason: null })
    expect(buildCloseTicketPayload(false, '   ')).toEqual({ finalize: false, close_reason: null })
  })
})

describe('classifyTicketActionError', () => {
  it('409 -> translated errorAlreadyClaimed, never the raw server text', () => {
    expect(classifyTicketActionError(409, { error: 'Ticket is already assigned' })).toEqual({
      translatedKey: 'errorAlreadyClaimed',
      detail: null,
    })
  })

  it('429 -> translated errorRateLimited', () => {
    expect(classifyTicketActionError(429, { error: 'Rate limit exceeded' })).toEqual({
      translatedKey: 'errorRateLimited',
      detail: null,
    })
  })

  it('400 -> shows the (already-sanitized) server message as-is', () => {
    expect(classifyTicketActionError(400, { error: 'Ticket is not available to claim (must be open)' })).toEqual({
      translatedKey: null,
      detail: 'Ticket is not available to claim (must be open)',
    })
  })

  it('403 -> translated errorForbidden, body ignored', () => {
    expect(classifyTicketActionError(403, { error: 'Forbidden' })).toEqual({
      translatedKey: 'errorForbidden',
      detail: null,
    })
  })

  it('500 (or anything else) -> generic translated message, raw body never surfaced', () => {
    const info = classifyTicketActionError(500, { error: 'relation "tickets" does not exist' })
    expect(info.translatedKey).toBe('errorGeneric')
    expect(info.detail).toBeNull()
  })

  it('400 with a non-string/missing error body falls back to null detail', () => {
    expect(classifyTicketActionError(400, null)).toEqual({ translatedKey: null, detail: null })
    expect(classifyTicketActionError(400, {})).toEqual({ translatedKey: null, detail: null })
  })
})

describe('isAdminOrOwner', () => {
  it('true for owner and admin, false for agent/viewer/null', () => {
    expect(isAdminOrOwner('owner')).toBe(true)
    expect(isAdminOrOwner('admin')).toBe(true)
    expect(isAdminOrOwner('agent')).toBe(false)
    expect(isAdminOrOwner('viewer')).toBe(false)
    expect(isAdminOrOwner(null)).toBe(false)
  })
})
