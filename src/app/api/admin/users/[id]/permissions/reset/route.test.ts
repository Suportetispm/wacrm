import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  fetchPlatformUser: vi.fn(),
  resetOverrides: vi.fn(),
  loadOverridesForUser: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  toPlatformErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/platform/admin-client', () => ({
  supabaseAdmin: () => ({}),
}))

vi.mock('@/lib/platform/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/users')>()
  return { ...actual, fetchPlatformUser: mocks.fetchPlatformUser }
})

vi.mock('@/lib/permissions/store', () => ({
  resetOverrides: mocks.resetOverrides,
  loadOverridesForUser: mocks.loadOverridesForUser,
}))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'agent-1' }) }

const AGENT_USER = {
  id: 'agent-1',
  full_name: 'Agent Smith',
  email: 'agent@acme.com',
  account: { id: 'acct-1', name: 'Acme' },
  account_role: 'agent' as const,
  is_active: true,
  queues: [],
  created_at: 'now',
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.fetchPlatformUser.mockReset()
  mocks.resetOverrides.mockReset()
  mocks.loadOverridesForUser.mockReset()
  mocks.loadOverridesForUser.mockResolvedValue(new Map())
})

describe('POST /api/admin/users/[id]/permissions/reset', () => {
  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await POST(new Request('http://x'), params)
    expect(res.status).toBe(403)
    expect(mocks.resetOverrides).not.toHaveBeenCalled()
  })

  it('400s for a non-agent target', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue({ ...AGENT_USER, account_role: 'admin' })
    const res = await POST(new Request('http://x'), params)
    expect(res.status).toBe(400)
    expect(mocks.resetOverrides).not.toHaveBeenCalled()
  })

  it('resets all overrides for a valid agent target and returns the (now all-default) effective set', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(AGENT_USER)
    mocks.resetOverrides.mockResolvedValue(undefined)

    const res = await POST(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.resetOverrides).toHaveBeenCalledWith('acct-1', 'agent-1')
    expect(json.overrides).toEqual({})
    expect(json.effective['users.view']).toBe(false)
    expect(json.effective['flows.view']).toBe(true)
  })
})
