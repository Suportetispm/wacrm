import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return { ...actual, checkRateLimit: mocks.checkRateLimit }
})

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'ticket-1' }) }

function request() {
  return new Request('http://localhost/api/tickets/ticket-1/resume', { method: 'POST' })
}

function ctx() {
  return { supabase: { rpc: mocks.rpc }, userId: 'user-1' }
}

const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.rpc.mockReset()
  mocks.checkRateLimit.mockReset()
  mocks.checkRateLimit.mockReturnValue({ success: true, remaining: 29, reset: Date.now() + 60_000, limit: 30 })
})

describe('POST /api/tickets/[id]/resume', () => {
  it('rejects an unauthenticated caller with 401, before calling the RPC', async () => {
    mocks.getCurrentAccount.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(request(), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns 429 when the rate limit is exceeded, before calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.checkRateLimit.mockReturnValue({ success: false, remaining: 0, reset: Date.now() + 1000, limit: 30 })

    const res = await POST(request(), params)
    expect(res.status).toBe(429)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('calls resume_ticket with the ticket id, no body needed', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: { id: 'ticket-1', status: 'open' },
      error: null,
    })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ticket.status).toBe('open')
    expect(mocks.rpc).toHaveBeenCalledWith('resume_ticket', { p_ticket_id: 'ticket-1' })
  })

  it("surfaces an invalid-state RPC error (22023, ticket not 'pending') as 400", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Ticket is not waiting on the customer' },
    })

    const res = await POST(request(), params)
    expect(res.status).toBe(400)
  })
})
