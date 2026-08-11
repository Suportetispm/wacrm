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

function request(body: unknown) {
  return new Request('http://localhost/api/tickets/ticket-1/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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

describe('POST /api/tickets/[id]/close', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.getCurrentAccount.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(request({ finalize: false }), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns 429 when the rate limit is exceeded, before touching the body', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.checkRateLimit.mockReturnValue({ success: false, remaining: 0, reset: Date.now() + 1000, limit: 30 })

    const res = await POST(request({ finalize: false }), params)
    expect(res.status).toBe(429)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing finalize without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({}), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean finalize without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ finalize: 'true' }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a close_reason over 500 characters without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ finalize: false, close_reason: 'x'.repeat(501) }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-string close_reason without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ finalize: false, close_reason: 42 }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('finalize=false calls close_ticket with p_finalize=false', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({ data: { id: 'ticket-1', status: 'closed' }, error: null })

    const res = await POST(request({ finalize: false, close_reason: 'resolved' }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ticket.status).toBe('closed')
    expect(mocks.rpc).toHaveBeenCalledWith('close_ticket', {
      p_ticket_id: 'ticket-1',
      p_close_reason: 'resolved',
      p_finalize: false,
    })
  })

  it('finalize=true calls close_ticket with p_finalize=true', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({ data: { id: 'ticket-1', status: 'closed' }, error: null })

    const res = await POST(request({ finalize: true }), params)

    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('close_ticket', {
      p_ticket_id: 'ticket-1',
      p_close_reason: null,
      p_finalize: true,
    })
  })

  it('omitted close_reason is passed through as null (never undefined)', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({ data: { id: 'ticket-1', status: 'closed' }, error: null })

    await POST(request({ finalize: false }), params)

    expect(mocks.rpc).toHaveBeenCalledWith('close_ticket', {
      p_ticket_id: 'ticket-1',
      p_close_reason: null,
      p_finalize: false,
    })
  })

  it('surfaces an RPC error (e.g. already closed, 22023) as 400', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Ticket is already closed' },
    })

    const res = await POST(request({ finalize: false }), params)
    expect(res.status).toBe(400)
  })

  it('surfaces a permission RPC error (42501) as 403', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Only the assigned agent or an admin can close this ticket' },
    })

    const res = await POST(request({ finalize: false }), params)
    expect(res.status).toBe(403)
  })
})
