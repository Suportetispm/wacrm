import { beforeEach, describe, expect, it, vi } from 'vitest'

// PATCH (051's default_queue_id endpoint) and POST (Meta config save) are
// covered here — GET/DELETE predate this file and have no existing test
// harness to extend within this change's scope.
//
// POST used to authenticate with a bare `auth.getUser()` + manual profile
// lookup, with NO role check — any authenticated member could reach
// verifyPhoneNumber/registerPhoneNumber/subscribeWabaToApp on Meta before
// the whatsapp_config_insert/update RLS policies (which already require
// 'admin') ever ran on the persistence step, effectively letting a
// non-admin use the route as an oracle to probe an arbitrary access_token
// against Meta. The fix swaps that manual block for requireRole('admin'),
// called before any Meta call — the POST tests below lock in that
// ordering.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: mocks.requireRole }
})

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  registerPhoneNumber: mocks.registerPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
}))

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { PATCH, POST } from './route'

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `.from()` distinguishes the tenancy pre-check (`queues`) from the
 *  actual write (`whatsapp_config`). `.eq()` is self-referential so any
 *  number of chained filters resolves the same way.
 *
 *  ETAPA 077A: PATCH/DELETE now resolve the primary row via
 *  `loadPrimaryWhatsAppConfigRow` (a `.select(...).eq(...).order(...)`
 *  read, no `.single()`/`.maybeSingle()`) before writing, so the
 *  `whatsapp_config` branch below needs both a `select` handler for
 *  that lookup and the pre-existing `update` handler for the write
 *  itself — same `configExists` flag drives both. */
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
        // whatsapp_config: read (primary-row resolution) + write paths
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              order: async () => ({
                data: opts.configExists ? [{ id: 'config-1' }] : [],
                error: null,
              }),
            }
            return builder
          },
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

function postRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.update.mockReset()
  mocks.verifyPhoneNumber.mockReset()
  mocks.registerPhoneNumber.mockReset()
  mocks.subscribeWabaToApp.mockReset()
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
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError("This action requires the 'admin' role or higher"),
    )
    const res = await PATCH(patchRequest({ default_queue_id: null }))
    expect(res.status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/config', () => {
  it('rejects an unauthenticated caller before ever touching Meta', async () => {
    mocks.requireRole.mockRejectedValue(new UnauthorizedError())
    const res = await POST(postRequest({ phone_number_id: 'p', access_token: 't' }))
    expect(res.status).toBe(401)
    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.registerPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.subscribeWabaToApp).not.toHaveBeenCalled()
  })

  it('rejects a non-admin before ever touching Meta', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError("This action requires the 'admin' role or higher"),
    )
    const res = await POST(postRequest({ phone_number_id: 'p', access_token: 't' }))
    expect(res.status).toBe(403)
    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.registerPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.subscribeWabaToApp).not.toHaveBeenCalled()
  })

  it('proceeds past the guard for an admin — reaches body validation, not the auth check', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: {} as never,
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    })
    const res = await POST(postRequest({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/access_token and phone_number_id/i)
    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
  })
})
