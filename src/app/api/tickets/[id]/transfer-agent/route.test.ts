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
const VALID_AGENT_ID = '22222222-2222-4222-8222-222222222222'

function request(body: unknown) {
  return new Request('http://localhost/api/tickets/ticket-1/transfer-agent', {
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

describe('POST /api/tickets/[id]/transfer-agent', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.getCurrentAccount.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(request({ agent_user_id: VALID_AGENT_ID }), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns 429 when the rate limit is exceeded, before touching the body', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.checkRateLimit.mockReturnValue({ success: false, remaining: 0, reset: Date.now() + 1000, limit: 30 })

    const res = await POST(request({ agent_user_id: VALID_AGENT_ID }), params)
    expect(res.status).toBe(429)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing agent_user_id without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({}), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-string agent_user_id without calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ agent_user_id: [] }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a malformed (non-UUID-shaped) agent_user_id with 400, before calling the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    const res = await POST(request({ agent_user_id: 'not-a-uuid' }), params)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toContain('valid UUID')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('accepts a well-formed UUID and proceeds to the RPC', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: { id: 'ticket-1', assigned_agent_id: VALID_AGENT_ID, status: 'open' },
      error: null,
    })

    const res = await POST(request({ agent_user_id: VALID_AGENT_ID }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ticket.assigned_agent_id).toBe(VALID_AGENT_ID)
    expect(mocks.rpc).toHaveBeenCalledWith('transfer_ticket_agent', {
      p_ticket_id: 'ticket-1',
      p_agent_user_id: VALID_AGENT_ID,
    })
  })

  it("surfaces a target-validation RPC error (22023) as 400 (e.g. inactive/wrong role/not in queue)", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: "Target agent is not an active member of this ticket's queue" },
    })

    const res = await POST(request({ agent_user_id: VALID_AGENT_ID }), params)
    expect(res.status).toBe(400)
  })

  it('surfaces a permission RPC error (42501) as 403', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx())
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Only the currently assigned agent or an admin can transfer this ticket' },
    })

    const res = await POST(request({ agent_user_id: VALID_AGENT_ID }), params)
    expect(res.status).toBe(403)
  })
})
