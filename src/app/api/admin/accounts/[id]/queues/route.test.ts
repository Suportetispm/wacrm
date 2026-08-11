import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  adminFrom: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  toPlatformErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/platform/admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.adminFrom }),
}))

import { GET } from './route'

function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    is: vi.fn(() => obj),
    order: vi.fn(async () => result),
  }
  return obj
}

const params = { params: Promise.resolve({ id: 'acct-1' }) }

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })
const UNAUTHORIZED = Object.assign(new Error('Unauthorized'), { status: 401 })

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.adminFrom.mockReset()
})

describe('GET /api/admin/accounts/[id]/queues', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(UNAUTHORIZED)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(401)
  })

  it('rejects a non-platform-admin caller with 403, without querying the database', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(FORBIDDEN)
    const res = await GET(new Request('http://x'), params)
    expect(res.status).toBe(403)
    expect(mocks.adminFrom).not.toHaveBeenCalled()
  })

  it('lists non-archived queues for the given account, via the service-role client', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockReturnValue(
      chain({
        data: [
          { id: 'q1', name: 'Comercial', color: '#3b82f6', is_active: true },
          { id: 'q2', name: 'Suporte', color: '#ef4444', is_active: false },
        ],
        error: null,
      }),
    )

    const res = await GET(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.queues).toHaveLength(2)
    expect(mocks.adminFrom).toHaveBeenCalledWith('queues')
  })

  it('returns an empty array (never an error) when the account has no queues', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockReturnValue(chain({ data: [], error: null }))

    const res = await GET(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.queues).toEqual([])
  })

  it('returns 500 on a database error, without leaking internals', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })
    mocks.adminFrom.mockReturnValue(chain({ data: null, error: { code: '42P01', message: 'relation does not exist' } }))

    const res = await GET(new Request('http://x'), params)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain('relation')
  })
})
