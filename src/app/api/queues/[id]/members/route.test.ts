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
            single: async () => ({ data: { id: 'member-1', ...payload }, error: null }),
          }),
        }
      },
    }),
  }),
}))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'queue-1' }) }

function postRequest(body: unknown) {
  return new Request('http://localhost/api/queues/queue-1/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** ctx.supabase.from() must distinguish 'queues' (tenancy pre-check
 *  for the queue itself) from 'profiles' (tenancy pre-check for the
 *  target user) — the route now queries both before ever inserting. */
function ctxWith(opts: { queueFound: boolean; profileFound: boolean }) {
  return {
    accountId: 'acct-1',
    supabase: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (table === 'queues') {
                  return { data: opts.queueFound ? { id: 'queue-1' } : null, error: null }
                }
                return { data: opts.profileFound ? { user_id: 'user-2' } : null, error: null }
              },
            }),
          }),
        }),
      }),
    },
  }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.adminInsert.mockReset()
})

describe('POST /api/queues/[id]/members', () => {
  it('rejects a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(postRequest({ user_id: 'user-2' }), params)
    expect(res.status).toBe(403)
  })

  it('rejects a queue_id that does not belong to this account, before ever inserting', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ queueFound: false, profileFound: true }))
    const res = await POST(postRequest({ user_id: 'user-2' }), params)
    expect(res.status).toBe(404)
    expect(mocks.adminInsert).not.toHaveBeenCalled()
  })

  it('rejects a user_id with no profile in this account, before ever inserting', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ queueFound: true, profileFound: false }))
    const res = await POST(postRequest({ user_id: 'user-2' }), params)
    expect(res.status).toBe(400)
    expect(mocks.adminInsert).not.toHaveBeenCalled()
  })

  it('adds a member once both the queue and the target profile are confirmed in-account', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ queueFound: true, profileFound: true }))
    const res = await POST(postRequest({ user_id: 'user-2', role_in_queue: 'supervisor', weight: 5 }), params)
    expect(res.status).toBe(201)
    expect(mocks.adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acct-1',
        queue_id: 'queue-1',
        user_id: 'user-2',
        role_in_queue: 'supervisor',
        weight: 5,
      }),
    )
  })
})
