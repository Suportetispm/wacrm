import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  adminFrom: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  toPlatformErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: mocks.rpc }),
}))

vi.mock('@/lib/platform/admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.adminFrom }),
}))

import { GET, POST } from './route'

function postRequest(body: unknown) {
  return new Request('http://localhost/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.rpc.mockReset()
  mocks.adminFrom.mockReset()
})

describe('GET /api/admin/accounts', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('rejects an ordinary authenticated user (not a platform admin) with 403 — same for a tenant owner/admin, this module has no concept of tenant role', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('lists every account cross-tenant once authorized, via the service-role client (never RLS-scoped)', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const order = vi.fn(async () => ({
      data: [{ id: 'acct-1', name: 'Acme', is_active: true }],
      error: null,
    }))
    mocks.adminFrom.mockReturnValue({ select: () => ({ order }) })

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.accounts).toEqual([{ id: 'acct-1', name: 'Acme', is_active: true }])
    expect(mocks.adminFrom).toHaveBeenCalledWith('accounts')
  })
})

describe('POST /api/admin/accounts', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'user-1' }))
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'user-1' }))
    expect(res.status).toBe(403)
  })

  it('rejects a missing name — account never gets created without one', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ owner_user_id: 'user-1' }))
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing owner_user_id — an account never gets created without an owner', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ name: 'Acme' }))
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('creates the account by delegating to platform_create_account, via the session-bound (RLS-scoped) client', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ data: 'new-acct-1', error: null })

    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'user-1' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.account_id).toBe('new-acct-1')
    expect(mocks.rpc).toHaveBeenCalledWith('platform_create_account', {
      p_name: 'Acme',
      p_owner_user_id: 'user-1',
    })
  })

  it('an invalid owner_user_id (RPC 22023) is rejected as 400, without leaking it in the message', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Target user does not exist' },
    })

    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'ghost-user' }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).not.toContain('ghost-user')
  })

  it("the target user's non-empty existing account (RPC 23505) surfaces as 409", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'Target user already has an account with data; cannot repurpose it into a new company' },
    })

    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'user-1' }))
    expect(res.status).toBe(409)
  })
})
