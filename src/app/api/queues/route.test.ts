import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  adminInsert: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/queues/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        mocks.adminInsert(payload)
        return {
          select: () => ({
            single: async () => ({ data: { id: 'queue-1', ...payload }, error: null }),
          }),
        }
      },
    }),
  }),
}))

import { GET, POST } from './route'

const CTX = { supabase: { name: 'scoped' }, accountId: 'acct-1', userId: 'user-1', role: 'admin', account: { id: 'acct-1', name: 'Acme' } }

function postRequest(body: unknown) {
  return new Request('http://localhost/api/queues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.getCurrentAccount.mockReset()
  mocks.adminInsert.mockReset()
})

describe('POST /api/queues', () => {
  it('rejects a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )
    const res = await POST(postRequest({ name: 'Support' }))
    expect(res.status).toBe(403)
  })

  it('rejects a missing name', async () => {
    mocks.requireRole.mockResolvedValue(CTX)
    const res = await POST(postRequest({}))
    expect(res.status).toBe(400)
  })

  it('creates a queue using the session account_id, never a client-supplied one', async () => {
    mocks.requireRole.mockResolvedValue(CTX)
    const res = await POST(postRequest({ name: 'Support', account_id: 'attacker-account' }))
    expect(res.status).toBe(201)
    expect(mocks.adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acct-1', name: 'Support' }),
    )
  })

  it('defaults chatbot_failure_queue_id to null unless the action is transfer_queue', async () => {
    mocks.requireRole.mockResolvedValue(CTX)
    await POST(postRequest({ name: 'Support', chatbot_failure_action: 'stay_in_queue', chatbot_failure_queue_id: 'other-queue' }))
    expect(mocks.adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({ chatbot_failure_action: 'stay_in_queue', chatbot_failure_queue_id: null }),
    )
  })
})

describe('GET /api/queues', () => {
  it('reads through the RLS-scoped session client, not the admin client, and includes member_count', async () => {
    // Table-aware mock: 'queues' supports .select().order(), the new
    // member-count bulk query on 'queue_members' supports
    // .select().eq().eq() — both go through the same RLS-scoped client.
    const from = vi.fn((table: string) => {
      if (table === 'queues') {
        return {
          select: () => ({
            order: async () => ({ data: [{ id: 'q1' }], error: null }),
          }),
        }
      }
      if (table === 'queue_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: [{ queue_id: 'q1' }, { queue_id: 'q1' }], error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    })
    mocks.getCurrentAccount.mockResolvedValue({ supabase: { from }, accountId: 'acct-1' })

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.queues).toEqual([{ id: 'q1', member_count: 2 }])
    expect(from).toHaveBeenCalledWith('queues')
    expect(from).toHaveBeenCalledWith('queue_members')
  })
})
