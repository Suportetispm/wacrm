import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  adminFrom: vi.fn(),
  fetchPlatformUser: vi.fn(),
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

vi.mock('@/lib/platform/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/users')>()
  return { ...actual, fetchPlatformUser: mocks.fetchPlatformUser }
})

import { GET, PATCH } from './route'

function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}

const params = { params: Promise.resolve({ id: 'user-1' }) }

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/admin/users/user-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

const sampleUser = {
  id: 'user-1',
  full_name: 'Jane Doe',
  email: 'jane@acme.com',
  account: { id: 'acct-1', name: 'Acme' },
  account_role: 'agent',
  is_active: true,
  queues: [],
  created_at: 'now',
}

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.rpc.mockReset()
  mocks.adminFrom.mockReset()
  mocks.fetchPlatformUser.mockReset()
})

describe('GET /api/admin/users/[id]', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(401)
  })

  it('rejects a non-platform-admin caller with 403 — id is never even read', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(403)
    expect(mocks.fetchPlatformUser).not.toHaveBeenCalled()
  })

  it('returns 404 when the profile is missing, or belongs to an owner/viewer (fetchPlatformUser returns null in both cases)', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.fetchPlatformUser.mockResolvedValue(null)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(404)
  })

  it('returns the sanitized user once authorized', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.fetchPlatformUser.mockResolvedValue(sampleUser)
    const res = await GET(new Request('http://x'), params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.user).toEqual(sampleUser)
  })
})

describe('PATCH /api/admin/users/[id]', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await PATCH(patchRequest({ full_name: 'New name' }), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await PATCH(patchRequest({ full_name: 'New name' }), params)
    expect(res.status).toBe(403)
  })

  it.each(['email', 'account_id', 'password'])(
    "rejects a body containing '%s' — not supported in this version",
    async (field) => {
      mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
      const res = await PATCH(patchRequest({ [field]: 'x' }), params)
      expect(res.status).toBe(400)
      expect(mocks.rpc).not.toHaveBeenCalled()
    },
  )

  it('rejects an empty full_name', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({ full_name: '   ' }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("rejects an account_role outside admin|agent (e.g. 'owner')", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({ account_role: 'owner' }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean is_active', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({ is_active: 'nope' }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects queue_ids that are not an array of strings', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({ queue_ids: ['ok', 5] }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects an empty body (no field to update)', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({}), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("rejects a queue that doesn't belong to this user's account, before calling the RPC", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { account_id: 'acct-1' }, error: null })
      if (table === 'queues') return chain({ data: [], error: null }) // none matched
      throw new Error(`unexpected table ${table}`)
    })
    const res = await PATCH(patchRequest({ queue_ids: ['q-from-another-account'] }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('cross-tenant queue check is skipped (falls through to the RPC) when the profile itself is not found', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'User not found' } })

    const res = await PATCH(patchRequest({ queue_ids: ['q1'] }), params)
    expect(mocks.rpc).toHaveBeenCalled()
    expect(res.status).toBe(400)
  })

  it('surfaces an RPC validation error (22023) as 400', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'User is not managed by the platform user management operation' } })
    const res = await PATCH(patchRequest({ full_name: 'New name' }), params)
    expect(res.status).toBe(400)
  })

  it("surfaces platform_update_user's role guard (22023) as 400 for a profile the RPC rejects — e.g. owner or viewer, not just owner", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({
      error: { code: '22023', message: 'User is not managed by the platform user management operation' },
    })
    const res = await PATCH(patchRequest({ is_active: false }), params)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe('User is not managed by the platform user management operation')
  })

  it('always passes every RPC parameter explicitly, using null for untouched fields', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue(sampleUser)

    const res = await PATCH(patchRequest({ is_active: false }), params)

    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('platform_update_user', {
      p_user_id: 'user-1',
      p_full_name: null,
      p_account_role: null,
      p_is_active: false,
      p_queue_ids: null,
    })
  })

  // Regression coverage requested for the "Falha ao atualizar status
  // do usuário" report: a deactivate-only PATCH ({ is_active: false })
  // must reach the RPC with p_is_active === false (a real boolean,
  // never dropped/omitted just because it's falsy) and every other
  // field explicitly null, and must surface the reloaded user with
  // is_active: false — not just a 200 with no body assertion.
  it('deactivate-only PATCH ({ is_active: false }) calls the RPC with p_is_active=false (not omitted) and returns the user with is_active: false', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue({ ...sampleUser, is_active: false })

    const res = await PATCH(patchRequest({ is_active: false }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    const callArgs = mocks.rpc.mock.calls[0][1]
    expect(callArgs.p_is_active).toBe(false)
    expect(callArgs.p_is_active).not.toBeUndefined()
    expect(callArgs.p_full_name).toBeNull()
    expect(callArgs.p_account_role).toBeNull()
    expect(callArgs.p_queue_ids).toBeNull()
    expect(json.user.is_active).toBe(false)
  })

  it('reactivate PATCH ({ is_active: true }) calls the RPC with p_is_active=true and returns the user with is_active: true', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue({ ...sampleUser, is_active: true })

    const res = await PATCH(patchRequest({ is_active: true }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('platform_update_user', {
      p_user_id: 'user-1',
      p_full_name: null,
      p_account_role: null,
      p_is_active: true,
      p_queue_ids: null,
    })
    expect(json.user.is_active).toBe(true)
  })

  it('returns the reloaded sanitized user on success', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue(sampleUser)

    const res = await PATCH(patchRequest({ full_name: 'Jane Doe' }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.user).toEqual(sampleUser)
  })
})
