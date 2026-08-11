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
const VALID_QUEUE_ID = '11111111-1111-4111-8111-111111111111'

function request(body: unknown) {
  return new Request('http://localhost/api/tickets/ticket-1/transfer-queue', {
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

describe('POST /api/tickets/[id]/transfer-queue', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.getCurrentAccount.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(request({ queue_id: VALID_QUEUE_ID }), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns 429 when the rate limit is exceeded, before touching the body', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.checkRateLimit.mockReturnValue({ success: false, remaining: 0, reset: Date.now() + 1000, limit: 30 })

    const res = await POST(request({ queue_id: VALID_QUEUE_ID }), params)
    expect(res.status).toBe(429)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing queue_id without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({}), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-string queue_id without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ queue_id: 123 }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a malformed (non-UUID-shaped) queue_id with 400, before calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ queue_id: 'not-a-uuid' }), params)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toContain('valid UUID')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('accepts a well-formed UUID and proceeds to the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: { id: 'ticket-1', queue_id: VALID_QUEUE_ID, status: 'open' },
      error: null,
    })

    const res = await POST(request({ queue_id: VALID_QUEUE_ID }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ticket.queue_id).toBe(VALID_QUEUE_ID)
    expect(mocks.rpc).toHaveBeenCalledWith('transfer_ticket_queue', {
      p_ticket_id: 'ticket-1',
      p_queue_id: VALID_QUEUE_ID,
    })
  })

  it('surfaces an RPC error (e.g. same-queue no-op, 22023) as 400 without duplicating the check here', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Ticket is already in this queue' },
    })

    const res = await POST(request({ queue_id: VALID_QUEUE_ID }), params)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Ticket is already in this queue')
  })

  it('surfaces a cross-tenant/permission RPC error (42501) as 403', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Caller cannot transfer this ticket' },
    })

    const res = await POST(request({ queue_id: VALID_QUEUE_ID }), params)
    expect(res.status).toBe(403)
  })
})
