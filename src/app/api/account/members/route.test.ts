import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

import { GET } from './route'

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

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
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
