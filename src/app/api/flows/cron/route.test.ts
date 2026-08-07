import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers the accounts.is_active pre-filter added in
// 047_platform_account_management.sql: stale active runs belonging
// to an inactive account must never be swept (marked timed_out) —
// they're simply skipped, left exactly as they were.

const mocks = vi.hoisted(() => ({
  getActiveAccountIds: vi.fn(),
}))

vi.mock('@/lib/accounts/active', () => ({
  getActiveAccountIds: mocks.getActiveAccountIds,
}))

const adminState = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  updatedIds: [] as string[],
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'flow_runs') {
        return {
          select: () => ({
            eq: async () => ({ data: adminState.runs, error: null }),
          }),
          update: () => {
            let id = ''
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                if (col === 'id') id = val as string
                return chain
              },
              select: async () => {
                adminState.updatedIds.push(id)
                return { data: [{ id }], error: null }
              },
            }
            return chain
          },
        }
      }
      if (table === 'flow_run_events') {
        return { insert: async () => ({ error: null }) }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }),
}))

import { GET } from './route'

const VERY_STALE = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

function req(secret = 'test-secret') {
  return new Request('http://localhost/api/flows/cron', {
    headers: { 'x-cron-secret': secret },
  })
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  adminState.runs = []
  adminState.updatedIds = []
  mocks.getActiveAccountIds.mockReset()
})

describe('GET /api/flows/cron — inactive accounts', () => {
  it('never sweeps (marks timed_out) a stale run belonging to an inactive account', async () => {
    adminState.runs = [
      { id: 'run-active', flow_id: 'f1', account_id: 'acct-active', user_id: 'u1', contact_id: 'c1', last_advanced_at: VERY_STALE, flows: { fallback_policy: null } },
      { id: 'run-inactive', flow_id: 'f2', account_id: 'acct-inactive', user_id: 'u1', contact_id: 'c2', last_advanced_at: VERY_STALE, flows: { fallback_policy: null } },
    ]
    mocks.getActiveAccountIds.mockResolvedValue(new Set(['acct-active']))

    const res = await GET(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.swept).toBe(1)
    expect(adminState.updatedIds).toEqual(['run-active'])
  })

  it('an all-active batch behaves exactly as before (no regression)', async () => {
    adminState.runs = [
      { id: 'run-1', flow_id: 'f1', account_id: 'acct-1', user_id: 'u1', contact_id: 'c1', last_advanced_at: VERY_STALE, flows: { fallback_policy: null } },
    ]
    mocks.getActiveAccountIds.mockResolvedValue(new Set(['acct-1']))

    const res = await GET(req())
    const json = await res.json()

    expect(json.swept).toBe(1)
  })
})
