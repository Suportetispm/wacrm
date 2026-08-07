import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression coverage for the cross-tenant IDOR fix: these routes use the
// service-role client (bypasses RLS), so account_id must be enforced in
// code. A "removed member" here means same user_id, but a *different*
// current accountId — exactly what `remove_account_member` produces when
// it relocates a former teammate to a fresh personal account while their
// old automations stay behind with the old account_id.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

type Row = Record<string, unknown>
type Filter = [string, unknown]

interface SelectChain {
  eq: (col: string, val: unknown) => SelectChain
  maybeSingle: () => Promise<{ data: Row | null; error: null }>
}

interface WriteChain {
  eq: (col: string, val: unknown) => WriteChain
  then: (resolve: (v: { error: null }) => unknown) => Promise<unknown>
}

function matches(row: Row, filters: Filter[]) {
  return filters.every(([col, val]) => row[col] === val)
}

/** Minimal fake Postgrest-like table backing select/update/delete with
 *  real WHERE-style filtering, so tests assert actual isolation behavior
 *  (row unreachable/unmodified) instead of just spying on call args. */
function createFakeAutomationsTable(initial: Row[]) {
  let rows = [...initial]

  function selectChain(filters: Filter[] = []): SelectChain {
    return {
      eq: (col, val) => selectChain([...filters, [col, val]]),
      maybeSingle: async () => {
        const match = rows.find((r) => matches(r, filters))
        return { data: match ?? null, error: null }
      },
    }
  }

  function updateChain(payload: Row, filters: Filter[] = []): WriteChain {
    const chain: WriteChain = {
      eq: (col, val) => updateChain(payload, [...filters, [col, val]]),
      then: (resolve) => {
        rows = rows.map((r) => (matches(r, filters) ? { ...r, ...payload } : r))
        return Promise.resolve({ error: null }).then(resolve)
      },
    }
    return chain
  }

  function deleteChain(filters: Filter[] = []): WriteChain {
    const chain: WriteChain = {
      eq: (col, val) => deleteChain([...filters, [col, val]]),
      then: (resolve) => {
        rows = rows.filter((r) => !matches(r, filters))
        return Promise.resolve({ error: null }).then(resolve)
      },
    }
    return chain
  }

  return {
    rows: () => rows,
    api: {
      select: () => selectChain(),
      update: (payload: Row) => updateChain(payload),
      delete: () => deleteChain(),
    },
  }
}

function makeAdmin(automations: ReturnType<typeof createFakeAutomationsTable>) {
  return {
    from: (table: string) => {
      if (table === 'automations') return automations.api
      if (table === 'automation_steps') {
        return {
          select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

const mockAdmin = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => mockAdmin.current,
}))

import { DELETE, GET, PATCH } from './route'

const ORIGINAL_ROW: Row = {
  id: 'auto-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  name: 'Original',
  description: null,
  trigger_type: 'manual',
  trigger_config: {},
  is_active: false,
}

const CTX_OWNER = { accountId: 'acct-1', userId: 'user-1' }
const CTX_OTHER_ACCOUNT = { accountId: 'acct-2', userId: 'user-2' }
// Same user_id as the creator, but resolved to a *different* current
// account — the shape produced by remove_account_member.
const CTX_REMOVED_MEMBER = { accountId: 'acct-3', userId: 'user-1' }

function params(id = 'auto-1') {
  return { params: Promise.resolve({ id }) }
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/automations/auto-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.requireRole.mockReset()
  mockAdmin.current = makeAdmin(createFakeAutomationsTable([{ ...ORIGINAL_ROW }]))
})

describe('GET /api/automations/[id]', () => {
  it('A: the owning user in the same account can read it', async () => {
    mocks.getCurrentAccount.mockResolvedValue(CTX_OWNER)
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.automation.id).toBe('auto-1')
  })

  it('B: a user from a different account gets 404', async () => {
    mocks.getCurrentAccount.mockResolvedValue(CTX_OTHER_ACCOUNT)
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
  })

  it('C: a removed ex-member (same user_id, new account) gets 404', async () => {
    mocks.getCurrentAccount.mockResolvedValue(CTX_REMOVED_MEMBER)
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
  })

  it('H: a nonexistent id and a cross-tenant id return the same sanitized 404', async () => {
    mocks.getCurrentAccount.mockResolvedValue(CTX_OTHER_ACCOUNT)
    const crossTenant = await GET(new Request('http://x'), params('auto-1'))
    const missing = await GET(new Request('http://x'), params('does-not-exist'))
    expect(await crossTenant.json()).toEqual(await missing.json())
    expect(crossTenant.status).toBe(missing.status)
  })
})

describe('PATCH /api/automations/[id]', () => {
  it('A/J: the owning user in the same account can edit it', async () => {
    mocks.requireRole.mockResolvedValue(CTX_OWNER)
    const res = await PATCH(patchRequest({ name: 'Renamed' }), params())
    expect(res.status).toBe(200)
  })

  it('D: a removed ex-member cannot edit it, and the row is left untouched', async () => {
    mocks.requireRole.mockResolvedValue(CTX_REMOVED_MEMBER)
    const res = await PATCH(patchRequest({ name: 'Hijacked' }), params())
    expect(res.status).toBe(404)
    // Read back through a fresh GET as the real owner to confirm no mutation leaked.
    mocks.getCurrentAccount.mockResolvedValue(CTX_OWNER)
    const check = await GET(new Request('http://x'), params())
    const json = await check.json()
    expect(json.automation.name).toBe('Original')
  })

  it('I: a client-supplied account_id in the body is ignored', async () => {
    mocks.requireRole.mockResolvedValue(CTX_OWNER)
    await PATCH(patchRequest({ name: 'Renamed', account_id: 'attacker-account' }), params())
    mocks.getCurrentAccount.mockResolvedValue(CTX_OWNER)
    const check = await GET(new Request('http://x'), params())
    const json = await check.json()
    expect(json.automation.account_id).toBe('acct-1')
    expect(json.automation.name).toBe('Renamed')
  })
})

describe('DELETE /api/automations/[id]', () => {
  it('A/J: the owning user in the same account can delete it', async () => {
    mocks.requireRole.mockResolvedValue(CTX_OWNER)
    const res = await DELETE(new Request('http://x'), params())
    expect(res.status).toBe(200)
    mocks.getCurrentAccount.mockResolvedValue(CTX_OWNER)
    const check = await GET(new Request('http://x'), params())
    expect((await check.json()).error).toBe('Not found')
  })

  it('E: a removed ex-member cannot delete it — the row survives', async () => {
    mocks.requireRole.mockResolvedValue(CTX_REMOVED_MEMBER)
    await DELETE(new Request('http://x'), params())
    mocks.getCurrentAccount.mockResolvedValue(CTX_OWNER)
    const check = await GET(new Request('http://x'), params())
    expect(check.status).toBe(200)
  })
})
