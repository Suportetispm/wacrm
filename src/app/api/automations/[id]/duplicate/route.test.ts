import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  automationInsert: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
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

function matches(row: Row, filters: Filter[]) {
  return filters.every(([col, val]) => row[col] === val)
}

function selectChain(rows: Row[], filters: Filter[] = []): SelectChain {
  return {
    eq: (col, val) => selectChain(rows, [...filters, [col, val]]),
    maybeSingle: async () => ({ data: rows.find((r) => matches(r, filters)) ?? null, error: null }),
  }
}

function makeAdmin(originalRow: Row) {
  return {
    from: (table: string) => {
      if (table === 'automations') {
        return {
          select: () => selectChain([originalRow]),
          insert: (payload: Row) => {
            mocks.automationInsert(payload)
            const copy = { id: 'auto-copy-1', ...payload }
            return { select: () => ({ single: async () => ({ data: copy, error: null }) }) }
          },
        }
      }
      if (table === 'automation_steps') {
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: [], error: null }) }),
          }),
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

import { POST } from './route'

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
// Same user_id as the creator, but resolved to a *different* current
// account — the shape produced by remove_account_member.
const CTX_REMOVED_MEMBER = { accountId: 'acct-3', userId: 'user-1' }
const CTX_OTHER_ACCOUNT = { accountId: 'acct-2', userId: 'user-2' }

function params(id = 'auto-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.automationInsert.mockReset()
  mockAdmin.current = makeAdmin({ ...ORIGINAL_ROW })
})

describe('POST /api/automations/[id]/duplicate', () => {
  it('G/J: the owning user can duplicate, and the clone is inserted into ctx.accountId', async () => {
    mocks.requireRole.mockResolvedValue(CTX_OWNER)
    const res = await POST(new Request('http://x'), params())
    expect(res.status).toBe(201)
    expect(mocks.automationInsert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acct-1', user_id: 'user-1' }),
    )
  })

  it('F: a removed ex-member cannot duplicate it — 404, nothing inserted', async () => {
    mocks.requireRole.mockResolvedValue(CTX_REMOVED_MEMBER)
    const res = await POST(new Request('http://x'), params())
    expect(res.status).toBe(404)
    expect(mocks.automationInsert).not.toHaveBeenCalled()
  })

  it('H: a nonexistent id and a cross-tenant id return the same sanitized 404', async () => {
    mocks.requireRole.mockResolvedValue(CTX_OTHER_ACCOUNT)
    const crossTenant = await POST(new Request('http://x'), params('auto-1'))
    const missing = await POST(new Request('http://x'), params('does-not-exist'))
    expect(await crossTenant.json()).toEqual(await missing.json())
    expect(crossTenant.status).toBe(missing.status)
    expect(mocks.automationInsert).not.toHaveBeenCalled()
  })
})
