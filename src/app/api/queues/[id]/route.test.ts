import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  adminUpdate: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/queues/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        mocks.adminUpdate(payload)
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: { id: 'queue-1', ...payload }, error: null }),
              }),
            }),
          }),
        }
      },
    }),
  }),
}))

import { PATCH } from './route'

const params = { params: Promise.resolve({ id: 'queue-1' }) }

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/queues/queue-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** ctx.supabase.from() distinguishes the pre-check lookups this route
 *  can make: the queue's own current archived_at (for the activate
 *  guard), a transfer target queue (for chatbot_failure_queue_id
 *  tenancy), and (051) an active queue_members lookup for
 *  primary_agent_id. `.eq()` is self-referential so any number of
 *  chained calls before the terminal `.maybeSingle()` resolves the
 *  same way, regardless of how many `.eq()` filters a given query uses. */
function ctxWith(opts: {
  archivedAt?: string | null
  transferTargetFound?: boolean
  primaryAgentIsActiveMember?: boolean
}) {
  return {
    accountId: 'acct-1',
    supabase: {
      from: (table: string) => ({
        select: (cols: string) => {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => {
              if (table === 'queue_members') {
                return {
                  data: opts.primaryAgentIsActiveMember ? { id: 'qm-1' } : null,
                  error: null,
                }
              }
              if (cols === 'archived_at') {
                return { data: { archived_at: opts.archivedAt ?? null }, error: null }
              }
              return { data: opts.transferTargetFound ? { id: 'queue-2' } : null, error: null }
            },
          }
          return builder
        },
      }),
    },
  }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.adminUpdate.mockReset()
})

describe('PATCH /api/queues/[id] — lifecycle actions', () => {
  it('pauses without touching archived_at', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({ action: 'pause' }), params)
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith({ is_active: false })
  })

  it('archives with is_active=false and archived_at set', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({ action: 'archive' }), params)
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false, archived_at: expect.any(String) }),
    )
  })

  it('activates a paused (not archived) queue', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ archivedAt: null }))
    const res = await PATCH(patchRequest({ action: 'activate' }), params)
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith({ is_active: true })
  })

  it('refuses to reactivate an archived queue directly', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ archivedAt: '2026-01-01T00:00:00.000Z' }))
    const res = await PATCH(patchRequest({ action: 'activate' }), params)
    expect(res.status).toBe(409)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/queues/[id] — chatbot_failure_queue_id', () => {
  it('requires chatbot_failure_queue_id when action is transfer_queue', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(
      patchRequest({ chatbot_failure_action: 'transfer_queue' }),
      params,
    )
    expect(res.status).toBe(400)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })

  it('rejects the queue referencing itself as the transfer target', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(
      patchRequest({ chatbot_failure_action: 'transfer_queue', chatbot_failure_queue_id: 'queue-1' }),
      params,
    )
    expect(res.status).toBe(400)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })

  it('rejects a transfer target that is not in this account, before ever updating', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ transferTargetFound: false }))
    const res = await PATCH(
      patchRequest({ chatbot_failure_action: 'transfer_queue', chatbot_failure_queue_id: 'queue-2' }),
      params,
    )
    expect(res.status).toBe(400)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })

  it('clears chatbot_failure_queue_id when the action is not transfer_queue', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(
      patchRequest({ chatbot_failure_action: 'stay_in_queue', chatbot_failure_queue_id: 'queue-2' }),
      params,
    )
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ chatbot_failure_action: 'stay_in_queue', chatbot_failure_queue_id: null }),
    )
  })

  it('accepts a valid transfer target in the same account', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ transferTargetFound: true }))
    const res = await PATCH(
      patchRequest({ chatbot_failure_action: 'transfer_queue', chatbot_failure_queue_id: 'queue-2' }),
      params,
    )
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ chatbot_failure_action: 'transfer_queue', chatbot_failure_queue_id: 'queue-2' }),
    )
  })
})

describe('PATCH /api/queues/[id] — primary_agent_id (051)', () => {
  it('clears primary_agent_id when null, without any pre-check lookup', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({ primary_agent_id: null }), params)
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith({ primary_agent_id: null })
  })

  it('accepts an active member of this queue', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ primaryAgentIsActiveMember: true }))
    const res = await PATCH(patchRequest({ primary_agent_id: 'user-1' }), params)
    expect(res.status).toBe(200)
    expect(mocks.adminUpdate).toHaveBeenCalledWith({ primary_agent_id: 'user-1' })
  })

  it('rejects a user who is not an active member of this queue, before ever updating', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ primaryAgentIsActiveMember: false }))
    const res = await PATCH(patchRequest({ primary_agent_id: 'user-1' }), params)
    expect(res.status).toBe(400)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })

  it('rejects a non-string, non-null primary_agent_id', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({ primary_agent_id: 42 }), params)
    expect(res.status).toBe(400)
    expect(mocks.adminUpdate).not.toHaveBeenCalled()
  })
})
