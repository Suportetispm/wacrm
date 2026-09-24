import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkNewConnectionAllowed: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/account/admin-client', () => ({
  supabaseAdmin: vi.fn(() => ({ admin: true })),
}))

vi.mock('@/lib/whatsapp/connection-gate', () => ({
  checkNewConnectionAllowed: mocks.checkNewConnectionAllowed,
}))

import { GET } from './route'

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.checkNewConnectionAllowed.mockReset()
  mocks.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('GET /api/whatsapp/connection-gate', () => {
  it('reports a blocked additional connection when the flag is off', async () => {
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'multi_connection_disabled',
      connectionCount: 1,
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      can_add_connection: false,
      multi_connection_enabled: false,
      connection_count: 1,
    })
  })

  it('reports the flag when enabled', async () => {
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: true,
      connectionCount: 1,
      multiConnectionEnabled: true,
    })
    const res = await GET()
    expect(await res.json()).toEqual({
      can_add_connection: true,
      multi_connection_enabled: true,
      connection_count: 1,
    })
  })

  it('500s on lookup failure', async () => {
    mocks.checkNewConnectionAllowed.mockResolvedValue({ allowed: false, reason: 'lookup_failed' })
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('requires admin', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: 'Forbidden' })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(mocks.checkNewConnectionAllowed).not.toHaveBeenCalled()
  })
})
