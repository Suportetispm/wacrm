import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers the accounts.is_active pre-filter added in
// 047_platform_account_management.sql: rows belonging to an inactive
// account must never be claimed (status stays 'pending', nothing is
// lost) and resumePendingExecution must never be called for them.

const mocks = vi.hoisted(() => ({
  resumePendingExecution: vi.fn(async () => {}),
  getActiveAccountIds: vi.fn(),
}))

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: mocks.resumePendingExecution,
}))
vi.mock('@/lib/accounts/active', () => ({
  getActiveAccountIds: mocks.getActiveAccountIds,
}))

const adminState = vi.hoisted(() => ({
  dueRows: [] as Record<string, unknown>[],
  claimedIds: [] as string[],
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => {
        const queryChain: Record<string, unknown> = {
          eq: () => queryChain,
          lte: () => queryChain,
          order: () => queryChain,
          limit: async () => ({ data: adminState.dueRows, error: null }),
        }
        return queryChain
      },
      update: () => {
        let claimedId = ''
        const claimChain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            if (col === 'id') claimedId = val as string
            return claimChain
          },
          select: () => claimChain,
          maybeSingle: async () => {
            adminState.claimedIds.push(claimedId)
            return { data: { id: claimedId }, error: null }
          },
        }
        return claimChain
      },
    }),
  }),
}))

import { GET } from './route'

function req(secret = 'test-secret') {
  return new Request('http://localhost/api/automations/cron', {
    headers: { 'x-cron-secret': secret },
  })
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  adminState.dueRows = []
  adminState.claimedIds = []
  mocks.resumePendingExecution.mockClear()
  mocks.getActiveAccountIds.mockReset()
})

describe('GET /api/automations/cron — inactive accounts', () => {
  it('never claims or resumes rows for an inactive account — pending data is preserved', async () => {
    adminState.dueRows = [
      { id: 'p-active', account_id: 'acct-active', automation_id: 'a1', user_id: 'u1', contact_id: null, log_id: null, parent_step_id: null, branch: null, next_step_position: 0, context: {} },
      { id: 'p-inactive', account_id: 'acct-inactive', automation_id: 'a2', user_id: 'u1', contact_id: null, log_id: null, parent_step_id: null, branch: null, next_step_position: 0, context: {} },
    ]
    mocks.getActiveAccountIds.mockResolvedValue(new Set(['acct-active']))

    const res = await GET(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.processed).toBe(1)
    expect(json.skipped_inactive).toBe(1)
    expect(adminState.claimedIds).toEqual(['p-active'])
    expect(mocks.resumePendingExecution).toHaveBeenCalledTimes(1)
    expect(mocks.resumePendingExecution).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-active', account_id: 'acct-active' }),
    )
  })

  it('an all-active batch behaves exactly as before (no regression)', async () => {
    adminState.dueRows = [
      { id: 'p-1', account_id: 'acct-1', automation_id: 'a1', user_id: 'u1', contact_id: null, log_id: null, parent_step_id: null, branch: null, next_step_position: 0, context: {} },
    ]
    mocks.getActiveAccountIds.mockResolvedValue(new Set(['acct-1']))

    const res = await GET(req())
    const json = await res.json()

    expect(json.processed).toBe(1)
    expect(json.skipped_inactive).toBe(0)
  })
})
