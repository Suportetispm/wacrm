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

function makeSupabase(ticketRows: Record<string, unknown>[]) {
  function ticketsBuilder() {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.in = vi.fn(() => b)
    b.order = vi.fn(() => b)
    b.range = vi.fn(async () => ({ data: ticketRows, error: null, count: ticketRows.length }))
    return b
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'tickets') return ticketsBuilder()
      // queues / conversations hydration lookups
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.in = vi.fn(async () => ({ data: [], error: null }))
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
})
