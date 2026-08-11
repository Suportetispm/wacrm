import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

import { GET } from './route'

const CONV_ID = '11111111-1111-4111-8111-111111111111'
const QUEUE_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'

function makeSupabase(
  ticketRows: Record<string, unknown>[],
  hydration?: { queues?: Record<string, unknown>[]; conversations?: Record<string, unknown>[] },
) {
  const eqCalls: [string, unknown][] = []
  function ticketsBuilder() {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val])
      return b
    })
    b.in = vi.fn(() => b)
    b.order = vi.fn(() => b)
    b.range = vi.fn(async () => ({ data: ticketRows, error: null, count: ticketRows.length }))
    return b
  }
  return {
    eqCalls,
    from: vi.fn((table: string) => {
      if (table === 'tickets') return ticketsBuilder()
      // queues / conversations hydration lookups
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.in = vi.fn(async () => ({
        data: (table === 'conversations' ? hydration?.conversations : hydration?.queues) ?? [],
        error: null,
      }))
      return b
    }),
  }
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
})

describe('GET /api/tickets', () => {
  it('rejects an invalid status filter', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?status=bogus'))
    expect(res.status).toBe(400)
  })

  it('rejects an invalid priority filter', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?priority=extreme'))
    expect(res.status).toBe(400)
  })

  it('returns an empty list cleanly when there are no tickets', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?status=open'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.tickets).toEqual([])
  })

  // conversation_id filter (6E.3) — lets the future Inbox badge ask
  // "does this conversation have a ticket right now?" by reusing this
  // existing route instead of a dedicated endpoint.
  it('applies an eq(conversation_id, ...) filter when a well-formed conversation_id is provided', async () => {
    const supabase = makeSupabase([{ id: 'ticket-1', conversation_id: CONV_ID }])
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    const res = await GET(new Request(`http://localhost/api/tickets?conversation_id=${CONV_ID}`))
    expect(res.status).toBe(200)
    expect(supabase.eqCalls).toContainEqual(['conversation_id', CONV_ID])
  })

  it('a well-formed but unmatched conversation_id is not rejected as a 400 — RLS-scoped query just returns no rows', async () => {
    const otherRealLookingId = '99999999-9999-4999-8999-999999999999'
    const supabase = makeSupabase([])
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    const res = await GET(new Request(`http://localhost/api/tickets?conversation_id=${otherRealLookingId}`))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.tickets).toEqual([])
  })

  // UUID format validation (6E.3 revision) — malformed values return a
  // clean 400 instead of reaching Postgres as a cast error.
  it('rejects a malformed conversation_id (not UUID-shaped) with 400', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?conversation_id=not-a-real-id'))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toContain('valid UUID')
  })

  it('rejects a malformed queue_id (not UUID-shaped) with 400', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?queue_id=queue-1'))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toContain('valid UUID')
  })

  it('rejects a malformed assigned_agent_id (not UUID-shaped) with 400', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase([]) })
    const res = await GET(new Request('http://localhost/api/tickets?assigned_agent_id=user-1'))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toContain('valid UUID')
  })

  it('combines conversation_id with status/queue_id/assigned_agent_id — every filter is ANDed, RLS is still the authority underneath', async () => {
    const supabase = makeSupabase([])
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    const res = await GET(
      new Request(
        `http://localhost/api/tickets?conversation_id=${CONV_ID}&status=open&queue_id=${QUEUE_ID}&assigned_agent_id=${AGENT_ID}`,
      ),
    )
    expect(res.status).toBe(200)
    expect(supabase.eqCalls).toContainEqual(['status', 'open'])
    expect(supabase.eqCalls).toContainEqual(['queue_id', QUEUE_ID])
    expect(supabase.eqCalls).toContainEqual(['assigned_agent_id', AGENT_ID])
    expect(supabase.eqCalls).toContainEqual(['conversation_id', CONV_ID])
  })

  it('omits the conversation_id filter entirely when not provided', async () => {
    const supabase = makeSupabase([])
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    await GET(new Request('http://localhost/api/tickets'))
    expect(supabase.eqCalls.some(([col]) => col === 'conversation_id')).toBe(false)
  })

  // conversation_status hydration (6E.4) — one more selected column on
  // the same conversations round trip already fetching the contact
  // join, not an extra query. Powers the 5-state operational status
  // derivation client-side (src/lib/tickets/status.ts).
  it('hydrates each ticket with its conversation_status, from the same round trip as the contact join', async () => {
    const supabase = makeSupabase(
      [{ id: 'ticket-1', conversation_id: CONV_ID, queue_id: null }],
      { conversations: [{ id: CONV_ID, status: 'finalized', contact: { id: 'c1', name: 'Jane', phone: '+1' } }] },
    )
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    const res = await GET(new Request('http://localhost/api/tickets'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.tickets[0].conversation_status).toBe('finalized')
    expect(json.tickets[0].contact).toEqual({ id: 'c1', name: 'Jane', phone: '+1' })
  })

  it('conversation_status is null when the conversation cannot be found (never crashes)', async () => {
    const supabase = makeSupabase(
      [{ id: 'ticket-1', conversation_id: CONV_ID, queue_id: null }],
      { conversations: [] },
    )
    mocks.getCurrentAccount.mockResolvedValue({ supabase })
    const res = await GET(new Request('http://localhost/api/tickets'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.tickets[0].conversation_status).toBeNull()
    expect(json.tickets[0].contact).toBeNull()
  })
})
