import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  adminFrom: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
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
  supabaseAdmin: () => ({
    from: mocks.adminFrom,
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
  }),
}))

import { GET, POST } from './route'

// Chainable fake query builder — every filter method returns itself;
// awaiting it (or calling a terminal method) resolves to `result`.
// Mirrors src/app/api/admin/users/route.test.ts.
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    order: vi.fn(() => obj),
    delete: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

const validNewOwnerBody = {
  name: 'Acme',
  owner_full_name: 'Jane Doe',
  owner_email: 'jane@acme.com',
  owner_password: 'correct-horse',
}

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.rpc.mockReset()
  mocks.adminFrom.mockReset()
  mocks.createUser.mockReset()
  mocks.deleteUser.mockReset()
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

  it('returns an empty list without querying profiles when there are no accounts', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: [], error: null })
      throw new Error(`unexpected table ${table}`)
    })
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.accounts).toEqual([])
  })

  it('lists every account cross-tenant once authorized, hydrated with a user_count per account, via the service-role client (never RLS-scoped)', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') {
        return chain({ data: [{ id: 'acct-1', name: 'Acme', is_active: true }], error: null })
      }
      if (table === 'profiles') {
        return chain({
          data: [{ account_id: 'acct-1' }, { account_id: 'acct-1' }, { account_id: 'acct-1' }],
          error: null,
        })
      }
      throw new Error(`unexpected table ${table}`)
    })

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.accounts).toEqual([{ id: 'acct-1', name: 'Acme', is_active: true, user_count: 3 }])
    expect(mocks.adminFrom).toHaveBeenCalledWith('accounts')
    expect(mocks.adminFrom).toHaveBeenCalledWith('profiles')
  })

  it('reports user_count: 0 for an account with no members yet', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') {
        return chain({ data: [{ id: 'acct-1', name: 'Acme', is_active: true }], error: null })
      }
      if (table === 'profiles') return chain({ data: [], error: null })
      throw new Error(`unexpected table ${table}`)
    })

    const res = await GET()
    const json = await res.json()
    expect(json.accounts[0].user_count).toBe(0)
  })
})

describe('POST /api/admin/accounts — mode (a): existing owner_user_id', () => {
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

  it('creates the account by delegating to platform_create_account, via the session-bound (RLS-scoped) client', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ data: 'new-acct-1', error: null })

    const res = await POST(postRequest({ name: 'Acme', owner_user_id: 'user-1' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.account_id).toBe('new-acct-1')
    expect(json.owner_user_id).toBe('user-1')
    expect(mocks.rpc).toHaveBeenCalledWith('platform_create_account', {
      p_name: 'Acme',
      p_owner_user_id: 'user-1',
    })
    expect(mocks.createUser).not.toHaveBeenCalled()
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

describe('POST /api/admin/accounts — mode (b): create the owner too (the actual UI flow)', () => {
  it('rejects a missing owner_full_name without touching auth.users', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validNewOwnerBody, owner_full_name: '' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects an invalid owner_email', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validNewOwnerBody, owner_email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a short owner_password', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validNewOwnerBody, owner_password: 'short' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('returns 409 when the owner email already exists, without calling platform_create_account', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.createUser.mockResolvedValue({
      data: null,
      error: { status: 422, message: 'A user with this email address has already been registered' },
    })
    const res = await POST(postRequest(validNewOwnerBody))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).not.toContain(validNewOwnerBody.owner_email)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('creates the owner then the account end-to-end, never echoing the password back', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-owner-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ data: 'new-acct-1', error: null })

    const res = await POST(postRequest(validNewOwnerBody))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.account_id).toBe('new-acct-1')
    expect(json.owner_user_id).toBe('new-owner-1')
    expect(JSON.stringify(json)).not.toContain(validNewOwnerBody.owner_password)
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: validNewOwnerBody.owner_email, password: validNewOwnerBody.owner_password }),
    )
    expect(mocks.rpc).toHaveBeenCalledWith('platform_create_account', {
      p_name: 'Acme',
      p_owner_user_id: 'new-owner-1',
    })
  })

  it('compensates (deletes the freshly created owner) when platform_create_account fails after the auth user was created', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-owner-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'boom' } })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      if (table === 'accounts') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.deleteUser.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validNewOwnerBody))

    expect(mocks.deleteUser).toHaveBeenCalledWith('new-owner-1')
    expect(res.status).toBe(409)
  })

  it('reports a distinct 500 when compensation deleteUser also fails, without leaking secrets', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-owner-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'boom' } })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      if (table === 'accounts') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.deleteUser.mockResolvedValue({ error: { message: 'cleanup failed' } })

    const res = await POST(postRequest(validNewOwnerBody))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain(validNewOwnerBody.owner_password)
  })
})
