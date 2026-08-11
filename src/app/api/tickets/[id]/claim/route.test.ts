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
  return new Request('http://localhost/api/tickets/ticket-1/claim', { method: 'POST' })
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

describe('POST /api/tickets/[id]/claim', () => {
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

  it('checks the rate limit under a per-user ticket-action key', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({ data: { id: 'ticket-1' }, error: null })

    await POST(request(), params)

    expect(mocks.checkRateLimit).toHaveBeenCalledWith('ticket:action:user-1', expect.objectContaining({ limit: 30 }))
  })

  it('calls claim_ticket with the ticket id from the URL, via the RLS-scoped client', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: { id: 'ticket-1', status: 'open', assigned_agent_id: 'user-1' },
      error: null,
    })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ticket.id).toBe('ticket-1')
    expect(mocks.rpc).toHaveBeenCalledWith('claim_ticket', { p_ticket_id: 'ticket-1' })
  })

  it('maps a 23505 (already assigned / lost the claim race) to 409', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'Ticket is already assigned' },
    })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toBe('Ticket is already assigned')
  })

  it('maps a 42501 (not an active member of the queue) to 403', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: "Caller is not an active member of this ticket's queue" },
    })

    const res = await POST(request(), params)
    expect(res.status).toBe(403)
  })

  it('maps a 22023 (invalid state, e.g. closed/pending/no queue) to 400', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Ticket is not available to claim (must be open)' },
    })

    const res = await POST(request(), params)
    expect(res.status).toBe(400)
  })

  it('collapses an unrecognized SQLSTATE to a generic 500, never leaking internals', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '58P01', message: 'could not read file "pg_internal/xyz"' },
    })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain('pg_internal')
  })
})
