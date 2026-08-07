import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  adminFrom: vi.fn(),
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
  supabaseAdmin: () => ({ from: mocks.adminFrom }),
}))

import { GET, PATCH } from './route'

const params = { params: Promise.resolve({ id: 'acct-1' }) }

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/admin/accounts/acct-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.rpc.mockReset()
  mocks.adminFrom.mockReset()
})

describe('GET /api/admin/accounts/[id]', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(401)
  })

  it('rejects a non-platform-admin caller with 403 — id is never even read from params', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(403)
    expect(mocks.adminFrom).not.toHaveBeenCalled()
  })

  it('returns account detail via the service-role client once authorized', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const maybeSingle = vi.fn(async () => ({
      data: { id: 'acct-1', name: 'Acme', is_active: true },
      error: null,
    }))
    mocks.adminFrom.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) })

    const res = await GET(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.account.id).toBe('acct-1')
  })

  it('a nonexistent account id returns a sanitized 404, no internal detail', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    })

    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/admin/accounts/[id]', () => {
  it('rejects an unauthenticated caller with 401, before touching the body', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await PATCH(patchRequest({ name: 'New name' }), params)
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-platform-admin caller with 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await PATCH(patchRequest({ name: 'New name' }), params)
    expect(res.status).toBe(403)
  })

  it('renames via platform_update_account, id from the URL, only after authorization', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ data: null, error: null })

    const res = await PATCH(patchRequest({ name: 'New name' }), params)
    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('platform_update_account', {
      p_account_id: 'acct-1',
      p_name: 'New name',
    })
  })

  it('disables via platform_set_account_active(false) on action=disable', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ data: null, error: null })

    const res = await PATCH(patchRequest({ action: 'disable' }), params)
    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('platform_set_account_active', {
      p_account_id: 'acct-1',
      p_is_active: false,
    })
  })

  it('re-enables via platform_set_account_active(true) on action=enable', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({ data: null, error: null })

    const res = await PATCH(patchRequest({ action: 'enable' }), params)
    expect(res.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('platform_set_account_active', {
      p_account_id: 'acct-1',
      p_is_active: true,
    })
  })

  it('rejects an unknown action value without calling any RPC', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({ action: 'delete' }), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a body with neither name nor action', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    const res = await PATCH(patchRequest({}), params)
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('a nonexistent account id (RPC 22023) never leaks the id in the error message', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Account not found' },
    })

    const res = await PATCH(patchRequest({ name: 'New name' }), params)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).not.toContain('acct-1')
  })
})
