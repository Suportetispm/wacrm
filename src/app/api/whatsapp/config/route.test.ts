import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only PATCH (051's default_queue_id endpoint) is covered here — GET/POST/
// DELETE predate this file and have no existing test harness to extend
// within this change's scope.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

import { PATCH } from './route'

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `.from()` distinguishes the tenancy pre-check (`queues`) from the
 *  actual write (`whatsapp_config`). `.eq()` is self-referential so any
 *  number of chained filters resolves the same way. */
function ctxWith(opts: { queueFound?: boolean; configExists?: boolean }) {
  return {
    accountId: 'acct-1',
    supabase: {
      from: (table: string) => {
        if (table === 'queues') {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => ({
              data: opts.queueFound ? { id: 'queue-1' } : null,
              error: null,
            }),
          }
          return { select: () => builder }
        }
        // whatsapp_config write path
        return {
          update: (payload: Record<string, unknown>) => {
            mocks.update(payload)
            const builder = {
              eq: () => builder,
              select: () => builder,
              maybeSingle: async () => ({
                data: opts.configExists
                  ? { id: 'config-1', default_queue_id: payload.default_queue_id }
                  : null,
                error: null,
              }),
            }
            return builder
          },
        }
      },
    },
  }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.update.mockReset()
})

describe('PATCH /api/whatsapp/config — default_queue_id (051)', () => {
  it('requires default_queue_id in the body', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({}))
    expect(res.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('clears default_queue_id when null, without a tenancy pre-check', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ configExists: true }))
    const res = await PATCH(patchRequest({ default_queue_id: null }))
    expect(res.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith({ default_queue_id: null })
  })

  it('accepts a queue that belongs to this account', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ queueFound: true, configExists: true }))
    const res = await PATCH(patchRequest({ default_queue_id: 'queue-1' }))
    expect(res.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith({ default_queue_id: 'queue-1' })
  })

  it('rejects a queue that is not in this account, before ever updating', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ queueFound: false }))
    const res = await PATCH(patchRequest({ default_queue_id: 'queue-from-another-account' }))
    expect(res.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('rejects a non-string, non-null default_queue_id', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({}))
    const res = await PATCH(patchRequest({ default_queue_id: 42 }))
    expect(res.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('404s when there is no saved config to update yet', async () => {
    mocks.requireRole.mockResolvedValue(ctxWith({ configExists: false }))
    const res = await PATCH(patchRequest({ default_queue_id: null }))
    expect(res.status).toBe(404)
  })

  it('propagates a role-check failure (non-admin) as-is', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: "This action requires the 'admin' role or higher" })
    const res = await PATCH(patchRequest({ default_queue_id: null }))
    expect(res.status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
