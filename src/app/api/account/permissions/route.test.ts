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

vi.mock('@/lib/permissions/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
      }),
    }),
  }),
}))

import { GET } from './route'

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
})

describe('GET /api/account/permissions', () => {
  it('propagates 401/403 from getCurrentAccount', async () => {
    mocks.getCurrentAccount.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    )
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('owner/admin/viewer get the legacy (rank-based) permission set — no DB read happens for them', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'viewer', accountId: 'acct-1', userId: 'user-1' })
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    // Viewer: every .manage/.create/.edit/.remove key is false, but
    // every .view key stayed unrestricted pre-FASE-1, so it's true.
    expect(json.permissions['users.view']).toBe(true)
    expect(json.permissions['users.create']).toBe(false)
    expect(json.permissions['flows.manage']).toBe(false)
  })

  it('an agent with no override rows gets AGENT_PERMISSION_DEFAULTS', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'agent', accountId: 'acct-1', userId: 'user-1' })
    const res = await GET()
    const json = await res.json()
    expect(json.permissions['users.view']).toBe(false)
    expect(json.permissions['queues.view']).toBe(false)
    expect(json.permissions['flows.view']).toBe(true)
    expect(json.permissions['automations.manage']).toBe(true)
    expect(json.permissions['quick_replies.manage']).toBe(true)
  })
})
