import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  adminFrom: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
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
  supabaseAdmin: () => ({
    from: mocks.adminFrom,
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
  }),
}))

vi.mock('@/lib/platform/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/users')>()
  return { ...actual, fetchPlatformUser: mocks.fetchPlatformUser }
})

import { GET, POST } from './route'

// Chainable fake query builder — every filter method returns itself;
// awaiting it (or calling a terminal method) resolves to `result`.
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    order: vi.fn(() => obj),
    range: vi.fn(() => obj),
    or: vi.fn(() => obj),
    delete: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}


function getRequest(qs = '') {
  return new Request(`http://localhost/api/admin/users${qs}`)
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

const validBody = {
  full_name: 'Jane Doe',
  email: 'jane@acme.com',
  password: 'correct-horse',
  account_id: 'acct-1',
  account_role: 'agent',
}

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.rpc.mockReset()
  mocks.adminFrom.mockReset()
  mocks.createUser.mockReset()
  mocks.deleteUser.mockReset()
  mocks.fetchPlatformUser.mockReset()
})

describe('GET /api/admin/users', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await GET(getRequest())
    expect(res.status).toBe(401)
  })

  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET(getRequest())
    expect(res.status).toBe(403)
  })

  it("rejects a 'role' outside admin|agent without touching the database", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await GET(getRequest('?role=owner'))
    expect(res.status).toBe(400)
    expect(mocks.adminFrom).not.toHaveBeenCalled()
  })

  it("rejects an 'is_active' value that isn't 'true'/'false'", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await GET(getRequest('?is_active=nope'))
    expect(res.status).toBe(400)
  })

  it('returns an empty list without querying accounts/queues when there are no matching profiles', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: [], error: null, count: 0 })
      throw new Error(`unexpected table ${table}`)
    })
    const res = await GET(getRequest())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.users).toEqual([])
  })

  it('assembles users with their account and queues, defaulting to admin|agent only', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const profileRow = {
      user_id: 'user-1',
      full_name: 'Jane',
      email: 'jane@acme.com',
      account_id: 'acct-1',
      account_role: 'agent',
      is_active: true,
      created_at: 'now',
    }
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: [profileRow], error: null, count: 1 })
      if (table === 'accounts') return chain({ data: [{ id: 'acct-1', name: 'Acme' }], error: null })
      if (table === 'queue_members') return chain({ data: [{ user_id: 'user-1', queue_id: 'q1' }], error: null })
      if (table === 'queues') return chain({ data: [{ id: 'q1', name: 'Suporte', color: '#fff' }], error: null })
      throw new Error(`unexpected table ${table}`)
    })

    const res = await GET(getRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.users).toEqual([
      {
        id: 'user-1',
        full_name: 'Jane',
        email: 'jane@acme.com',
        account: { id: 'acct-1', name: 'Acme' },
        account_role: 'agent',
        is_active: true,
        queues: [{ id: 'q1', name: 'Suporte', color: '#fff' }],
        created_at: 'now',
      },
    ])
  })
})

describe('POST /api/admin/users', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(401)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(403)
  })

  it('rejects a missing full_name', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validBody, full_name: '' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects an invalid email', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validBody, email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a password shorter than the minimum', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validBody, password: 'short' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it("rejects an account_role outside admin|agent (e.g. 'owner' or 'supervisor')", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await POST(postRequest({ ...validBody, account_role: 'owner' }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a nonexistent account before creating the auth user', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: null, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a disabled account before creating the auth user', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: false }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('rejects a queue from a different account before creating the auth user', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      if (table === 'queues') return chain({ data: [], error: null }) // none matched
      throw new Error(`unexpected table ${table}`)
    })
    const res = await POST(postRequest({ ...validBody, queue_ids: ['q-from-another-account'] }))
    expect(res.status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it("compensates and surfaces 400 when the attach RPC rejects the target account as the user's own temporary personal account (defense-in-depth guard)", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    let accountsCall = 0
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') {
        accountsCall += 1
        // 1st call: pre-createUser existence/active check. 2nd call:
        // compensateFailedUserCreation's delete of the temp account.
        return accountsCall === 1
          ? chain({ data: { id: 'acct-1', is_active: true }, error: null })
          : chain({ data: null, error: null })
      }
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({
      error: {
        code: '22023',
        message: 'Target account must be different from the temporary personal account',
      },
    })
    mocks.deleteUser.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validBody))
    const json = await res.json()

    expect(mocks.deleteUser).toHaveBeenCalledWith('new-user-1')
    expect(res.status).toBe(400)
    expect(json.error).toBe('Target account must be different from the temporary personal account')
  })

  it('returns 409 when the email already exists (auth admin conflict), without calling the attach RPC', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
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

  it('returns 500 on an unexpected auth admin error', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } })
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(500)
  })

  it('compensates by deleting the freshly created auth user when the attach RPC fails, and surfaces the RPC error', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: { code: '23505', message: 'Target user is not eligible to be attached' } })
    mocks.deleteUser.mockResolvedValue({ error: null })

    const res = await POST(postRequest(validBody))

    expect(mocks.deleteUser).toHaveBeenCalledWith('new-user-1')
    expect(res.status).toBe(409)
  })

  it('reports a distinct 500 when compensation deleteUser also fails, without leaking secrets', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      if (table === 'profiles') return chain({ data: { account_id: 'temp-acct-1' }, error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'Target account does not exist or is inactive' } })
    mocks.deleteUser.mockResolvedValue({ error: { message: 'cleanup failed' } })

    const res = await POST(postRequest(validBody))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain(validBody.password)
  })

  it('creates the user end-to-end and never echoes the password back', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') return chain({ data: { id: 'acct-1', is_active: true }, error: null })
      if (table === 'queues') return chain({ data: [{ id: 'q1' }], error: null })
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue({
      id: 'new-user-1',
      full_name: 'Jane Doe',
      email: 'jane@acme.com',
      account: { id: 'acct-1', name: 'Acme' },
      account_role: 'agent',
      is_active: true,
      queues: [],
      created_at: 'now',
    })

    const res = await POST(postRequest({ ...validBody, queue_ids: ['q1'] }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.user.id).toBe('new-user-1')
    expect(JSON.stringify(json)).not.toContain(validBody.password)
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: validBody.email, password: validBody.password, email_confirm: true }),
    )
    expect(mocks.rpc).toHaveBeenCalledWith('platform_attach_user_to_account', {
      p_user_id: 'new-user-1',
      p_account_id: 'acct-1',
      p_account_role: 'agent',
      p_full_name: 'Jane Doe',
      p_queue_ids: ['q1'],
    })
  })

  // PARTE 10 — regressão explícita do bug de produção: "Criar usuário"
  // nunca pode criar uma linha nova em public.accounts. A rota em si
  // nunca chama `.insert()` em 'accounts' (a única forma de uma conta
  // nascer é o trigger handle_new_user() em auth.users, fora do
  // controle desta rota, e platform_attach_user_to_account só faz
  // UPDATE/DELETE em accounts, nunca INSERT) — este teste falha se
  // algum código futuro reintroduzir um INSERT direto aqui.
  it('REGRESSION: never inserts into accounts — an existing account_id is looked up read-only, never created', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const accountsInsert = vi.fn()
    mocks.adminFrom.mockImplementation((table: string) => {
      if (table === 'accounts') {
        const obj = chain({ data: { id: 'acct-1', is_active: true }, error: null })
        obj.insert = accountsInsert
        return obj
      }
      throw new Error(`unexpected table ${table}`)
    })
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.fetchPlatformUser.mockResolvedValue({
      id: 'new-user-1',
      full_name: 'Jane Doe',
      email: 'jane@acme.com',
      account: { id: 'acct-1', name: 'Acme' },
      account_role: 'agent',
      is_active: true,
      queues: [],
      created_at: 'now',
    })

    const res = await POST(postRequest(validBody))

    expect(res.status).toBe(201)
    expect(accountsInsert).not.toHaveBeenCalled()
    // The only account-related RPC this route ever calls is the
    // attach RPC — never platform_create_account.
    expect(mocks.rpc).not.toHaveBeenCalledWith('platform_create_account', expect.anything())
  })
})
