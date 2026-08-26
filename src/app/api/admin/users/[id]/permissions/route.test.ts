import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  fetchPlatformUser: vi.fn(),
  loadOverridesForUser: vi.fn(),
  setOverrides: vi.fn(),
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
  loadOverridesForUser: mocks.loadOverridesForUser,
  setOverrides: mocks.setOverrides,
}))

import { GET, PUT } from './route'

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

const ADMIN_USER = { ...AGENT_USER, account_role: 'admin' as const }

function putRequest(body: unknown) {
  return new Request('http://localhost/api/admin/users/agent-1/permissions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.fetchPlatformUser.mockReset()
  mocks.loadOverridesForUser.mockReset()
  mocks.setOverrides.mockReset()
  mocks.loadOverridesForUser.mockResolvedValue(new Map())
})

describe('GET /api/admin/users/[id]/permissions', () => {
  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(403)
  })

  it('404s when the target user does not exist', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(null)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(404)
  })

  it('returns applicable:false for a non-agent target, without touching the override store', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(ADMIN_USER)
    const res = await GET(new Request('http://x'), params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.applicable).toBe(false)
    expect(json.role).toBe('admin')
    expect(mocks.loadOverridesForUser).not.toHaveBeenCalled()
  })

  it('returns overrides + effective permissions for an agent target', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(AGENT_USER)
    mocks.loadOverridesForUser.mockResolvedValue(new Map([['users.create', true]]))

    const res = await GET(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.applicable).toBe(true)
    expect(json.overrides).toEqual({ 'users.create': true })
    expect(json.effective['users.create']).toBe(true)
    expect(json.effective['flows.view']).toBe(true) // Herdar → default
    expect(mocks.loadOverridesForUser).toHaveBeenCalledWith('acct-1', 'agent-1')
  })
})

describe('PUT /api/admin/users/[id]/permissions', () => {
  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await PUT(putRequest({ overrides: { 'users.view': true } }), params)
    expect(res.status).toBe(403)
    expect(mocks.setOverrides).not.toHaveBeenCalled()
  })

  it('400s for a non-agent target — overrides only apply to agent users', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(ADMIN_USER)
    const res = await PUT(putRequest({ overrides: { 'users.view': true } }), params)
    expect(res.status).toBe(400)
    expect(mocks.setOverrides).not.toHaveBeenCalled()
  })

  it("rejects an unknown key — 'superadmin.access' can never be written, even by a platform admin", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(AGENT_USER)
    const res = await PUT(putRequest({ overrides: { 'superadmin.access': true } }), params)
    expect(res.status).toBe(400)
    expect(mocks.setOverrides).not.toHaveBeenCalled()
  })

  it("rejects 'users.disable' — retired key, never accepted", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(AGENT_USER)
    const res = await PUT(putRequest({ overrides: { 'users.disable': true } }), params)
    expect(res.status).toBe(400)
    expect(mocks.setOverrides).not.toHaveBeenCalled()
  })

  it('Permitir/Bloquear/Herdar (null) all pass through to setOverrides for a valid agent target', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'superadmin-1' })
    mocks.fetchPlatformUser.mockResolvedValue(AGENT_USER)
    mocks.setOverrides.mockResolvedValue(undefined)
    mocks.loadOverridesForUser.mockResolvedValue(new Map([['users.create', true]]))

    const res = await PUT(
      putRequest({ overrides: { 'users.create': true, 'queues.manage': false, 'flows.view': null } }),
      params,
    )

    expect(res.status).toBe(200)
    expect(mocks.setOverrides).toHaveBeenCalledWith(
      'acct-1',
      'agent-1',
      { 'users.create': true, 'queues.manage': false, 'flows.view': null },
      'superadmin-1',
    )
  })
})
