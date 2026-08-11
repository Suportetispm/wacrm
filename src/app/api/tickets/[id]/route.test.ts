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

const params = { params: Promise.resolve({ id: 'ticket-1' }) }

function makeSupabase(opts: {
  ticket: Record<string, unknown> | null
  ticketError?: unknown
  queue?: Record<string, unknown> | null
  conversation?: Record<string, unknown> | null
  events?: Record<string, unknown>[]
}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'tickets') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.ticket, error: opts.ticketError ?? null }),
            }),
          }),
        }
      }
      if (table === 'queues') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.queue ?? null }) }) }),
        }
      }
      if (table === 'conversations') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.conversation ?? null }) }) }),
        }
      }
      if (table === 'ticket_events') {
        return {
          select: () => ({ eq: () => ({ order: async () => ({ data: opts.events ?? [] }) }) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
})

describe('GET /api/tickets/[id]', () => {
  it('returns 404 when the ticket is missing or not visible to this caller (RLS)', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ supabase: makeSupabase({ ticket: null }) })
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(404)
  })

  it('returns 500 without leaking the raw DB error on a query failure', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: makeSupabase({ ticket: null, ticketError: { code: '42P01', message: 'relation does not exist' } }),
    })
    const res = await GET(new Request('http://x'), params)
    const json = await res.json()
    expect(res.status).toBe(500)
    expect(JSON.stringify(json)).not.toContain('relation')
  })

  // conversation_status hydration (6E.4) — same round trip already
  // fetching the contact join, one more selected column.
  it('hydrates the ticket with conversation_status, queue and contact', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: makeSupabase({
        ticket: { id: 'ticket-1', queue_id: 'queue-1', conversation_id: 'conv-1', status: 'closed' },
        queue: { id: 'queue-1', name: 'Suporte', color: '#fff' },
        conversation: { id: 'conv-1', status: 'finalized', contact: { id: 'c1', name: 'Jane', phone: '+1' } },
        events: [{ id: 'ev-1', event_type: 'created' }],
      }),
    })
    const res = await GET(new Request('http://x'), params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ticket.conversation_status).toBe('finalized')
    expect(json.ticket.queue).toEqual({ id: 'queue-1', name: 'Suporte', color: '#fff' })
    expect(json.ticket.contact).toEqual({ id: 'c1', name: 'Jane', phone: '+1' })
    expect(json.events).toHaveLength(1)
  })

  it('conversation_status is null when the conversation lookup finds nothing (never crashes)', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: makeSupabase({
        ticket: { id: 'ticket-1', queue_id: null, conversation_id: 'conv-1', status: 'open' },
        conversation: null,
      }),
    })
    const res = await GET(new Request('http://x'), params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ticket.conversation_status).toBeNull()
    expect(json.ticket.contact).toBeNull()
    expect(json.ticket.queue).toBeNull()
  })
})
