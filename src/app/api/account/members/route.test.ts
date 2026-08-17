import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  rpc: vi.fn(),
  queuesFrom: vi.fn(),
  adminFrom: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/account/admin-client', () => ({
  supabaseAdmin: () => ({
    from: mocks.adminFrom,
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
  }),
}))

import { GET, POST } from './route'

function makeSupabase(rows: Record<string, unknown>[]) {
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: rows, error: null }),
        }),
      }),
    })),
  }
}

// Chainable fake query builder for the service-role admin client used
// by compensateFailedUserCreation (profiles/accounts) — same helper
// shape as src/app/api/admin/users/route.test.ts.
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    delete: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/account/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })

const validBody = {
  full_name: 'Jane Doe',
  email: 'jane@acme.com',
  password: 'correct-horse',
  role: 'agent',
}

function makeCtx(overrides: Partial<{ userId: string; accountId: string; role: string }> = {}) {
  return {
    userId: overrides.userId ?? 'admin-1',
    accountId: overrides.accountId ?? 'acct-1',
    role: overrides.role ?? 'admin',
    supabase: {
      from: mocks.queuesFrom,
      rpc: mocks.rpc,
    },
  }
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.requireRole.mockReset()
  mocks.rpc.mockReset()
  mocks.queuesFrom.mockReset()
  mocks.adminFrom.mockReset()
  mocks.createUser.mockReset()
  mocks.deleteUser.mockReset()
})

describe('GET /api/account/members', () => {
  // is_active (6E.4) — added for the ticket transfer-agent candidate
  // filter (src/lib/tickets/candidates.ts); a deactivated member must
  // never be offered as a valid transfer target.
  it('includes is_active on every returned member', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      accountId: 'acct-1',
      role: 'admin',
      supabase: makeSupabase([
        {
          user_id: 'user-1',
          full_name: 'Jane',
          email: 'jane@acme.com',
          avatar_url: null,
          account_role: 'agent',
          is_active: true,
          created_at: 'now',
        },
        {
          user_id: 'user-2',
          full_name: 'Deactivated Dan',
          email: 'dan@acme.com',
          avatar_url: null,
          account_role: 'agent',
          is_active: false,
          created_at: 'now',
        },
      ]),
    })

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.members).toEqual([
      { user_id: 'user-1', full_name: 'Jane', email: 'jane@acme.com', avatar_url: null, role: 'agent', joined_at: 'now', is_active: true },
      { user_id: 'user-2', full_name: 'Deactivated Dan', email: 'dan@acme.com', avatar_url: null, role: 'agent', joined_at: 'now', is_active: false },
    ])
  })

  it('still hides email from non-admin+ callers (unchanged pre-existing behavior)', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      accountId: 'acct-1',
      role: 'agent',
      supabase: makeSupabase([
        {
          user_id: 'user-1',
          full_name: 'Jane',
          email: 'jane@acme.com',
          avatar_url: null,
          account_role: 'agent',
          is_active: true,
          created_at: 'now',
        },
      ]),
    })

    const res = await GET()
    const json = await res.json()

    expect(json.members[0].email).toBeNull()
    expect(json.members[0].is_active).toBe(true)
  })
})

describe('POST /api/account/members', () => {
  it('rejects a caller below admin (agent) with 403, before touching the body', async () => {
    mocks.requireRole.mockRejectedValue(FORBIDDEN)
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(403)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a viewer caller with 403', async () => {
    mocks.requireRole.mockRejectedValue(FORBIDDEN)
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(403)
  })

  it('owner/admin creates an agent in their own account — RPC gets no account_id at all', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx({ role: 'owner' }))
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validBody))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.user_id).toBe('new-user-1')
    expect(mocks.rpc).toHaveBeenCalledWith('create_account_member', {
      p_user_id: 'new-user-1',
      p_account_role: 'agent',
      p_full_name: 'Jane Doe',
      p_queue_ids: null,
    })
    // No account_id / p_account_id key anywhere in the RPC call — the
    // target account is never a parameter, only auth.uid() inside the RPC.
    const rpcArgs = mocks.rpc.mock.calls[0][1] as Record<string, unknown>
    expect('p_account_id' in rpcArgs).toBe(false)
    expect('account_id' in rpcArgs).toBe(false)
  })

  it('creates an admin in the caller\'s own account', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-2' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await POST(postRequest({ ...validBody, role: 'admin' }))

    expect(res.status).toBe(201)
    expect(mocks.rpc).toHaveBeenCalledWith(
      'create_account_member',
      expect.objectContaining({ p_account_role: 'admin' }),
    )
  })

  it('creates a viewer — the architecture already supports this role in the invite flow, so direct creation offers it too', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-3' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await POST(postRequest({ ...validBody, role: 'viewer' }))

    expect(res.status).toBe(201)
    expect(mocks.rpc).toHaveBeenCalledWith(
      'create_account_member',
      expect.objectContaining({ p_account_role: 'viewer' }),
    )
  })

  it("rejects role: 'owner' — owner is never created by this screen", async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    const res = await POST(postRequest({ ...validBody, role: 'owner' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it("ignores a client-supplied 'account_id' in the body entirely — the caller cannot pick an arbitrary account", async () => {
    mocks.requireRole.mockResolvedValue(makeCtx({ accountId: 'acct-real' }))
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-4' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await POST(
      postRequest({ ...validBody, account_id: 'someone-elses-account' }),
    )
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.user_id).toBe('new-user-4')
    // The forged field never reaches the RPC call under any key.
    const rpcArgs = mocks.rpc.mock.calls[0][1] as Record<string, unknown>
    expect(JSON.stringify(rpcArgs)).not.toContain('someone-elses-account')
  })

  it('rejects a queue from a different account before creating the auth user', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.queuesFrom.mockImplementation((table: string) => {
      if (table === 'queues') return chain({ data: [], error: null }) // none matched
      throw new Error(`unexpected table ${table}`)
    })

    const res = await POST(postRequest({ ...validBody, queue_ids: ['q-from-another-account'] }))

    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('returns 409 when the email already exists, without calling the attach RPC', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.createUser.mockResolvedValue({
      data: null,
      error: { status: 422, message: 'A user with this email address has already been registered' },
    })

    const res = await POST(postRequest(validBody))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).not.toContain(validBody.email)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('compensates by deleting the freshly created auth user when the attach RPC fails, and surfaces the RPC error', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      if (table === 'accounts') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-5' } }, error: null })
    mocks.rpc.mockResolvedValue({
      error: { code: '23505', message: 'Target user is not eligible to be attached' },
    })
    mocks.deleteUser.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validBody))

    expect(mocks.deleteUser).toHaveBeenCalledWith('new-user-5')
    expect(res.status).toBe(409)
  })

  it('reports a distinct 500 when compensation deleteUser also fails, without leaking the password', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      if (table === 'accounts') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-6' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'boom' } })
    mocks.deleteUser.mockResolvedValue({ error: { message: 'cleanup failed' } })

    const res = await POST(postRequest(validBody))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain(validBody.password)
  })

  // REGRESSION (mirrors the platform-side test in
  // src/app/api/admin/users/route.test.ts): this route must never
  // create a new public.accounts row. The only account mutation any
  // success path can cause is create_account_member's own DELETE of
  // the caller-less temp personal account — never an INSERT.
  it('REGRESSION: never inserts into accounts — public.accounts row count is unaffected by a successful create', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    const accountsInsert = vi.fn()
    mocks.adminFrom.mockImplementation((table: string) => {
      const obj = chain({ data: null, error: null })
      if (table === 'accounts') obj.insert = accountsInsert
      return obj
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-7' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validBody))

    expect(res.status).toBe(201)
    expect(accountsInsert).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith('platform_create_account', expect.anything())
    expect(mocks.rpc).not.toHaveBeenCalledWith('platform_attach_user_to_account', expect.anything())
  })
})
