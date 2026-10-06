import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  contactLookup: vi.fn(),
  createSignedUrl: vi.fn(),
  filters: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        mocks.filters[col] = val
        return b
      }
      b.maybeSingle = () => mocks.contactLookup(mocks.filters)
      return b
    },
    storage: { from: () => ({ createSignedUrl: mocks.createSignedUrl }) },
  }),
}))

import { GET } from './route'

const ACCOUNT = '11111111-1111-1111-1111-111111111111'
const OTHER_ACCOUNT = '99999999-9999-9999-9999-999999999999'
const CONTACT = '22222222-2222-2222-2222-222222222222'
const PATH = `${ACCOUNT}/contacts/${CONTACT}/${'a'.repeat(64)}.jpg`

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

/** Simulates the real query: only matches when BOTH id and account_id filters match the stored row. */
function storedContact(row: { id: string; account_id: string; whatsapp_avatar_path: string | null }) {
  mocks.contactLookup.mockImplementation(async (filters: Record<string, unknown>) => ({
    data: filters.id === row.id && filters.account_id === row.account_id ? row : null,
    error: null,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(mocks.filters)) delete mocks.filters[k]
  mocks.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: 'user-1', role: 'agent' })
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed-avatar?token=x' }, error: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/contacts/[id]/avatar', () => {
  it('authenticated, same account, with a synced photo: 302 to a short signed URL of the private bucket', async () => {
    storedContact({ id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: PATH })

    const res = await GET(new Request('http://localhost'), params(CONTACT))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://storage.example/signed-avatar?token=x')
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(PATH, 300)
    expect(mocks.filters).toMatchObject({ id: CONTACT, account_id: ACCOUNT })
  })

  it('no session: rejected before any lookup', async () => {
    mocks.requireRole.mockRejectedValue({ status: 401, message: 'Unauthorized' })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(401)
    expect(mocks.contactLookup).not.toHaveBeenCalled()
  })

  it('contact of another account → 404 (same as nonexistent), nothing signed', async () => {
    storedContact({ id: CONTACT, account_id: OTHER_ACCOUNT, whatsapp_avatar_path: `${OTHER_ACCOUNT}/contacts/${CONTACT}/${'a'.repeat(64)}.jpg` })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(404)
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('nonexistent contact → 404', async () => {
    mocks.contactLookup.mockResolvedValue({ data: null, error: null })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(404)
  })

  it('contact without a synced photo → 404', async () => {
    storedContact({ id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: null })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(404)
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('a stored path outside this contact\'s own prefix is never signed → 404', async () => {
    storedContact({ id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: `${ACCOUNT}/other-conversation/file.jpg` })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(404)
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('malformed id → 404 without any lookup', async () => {
    const res = await GET(new Request('http://localhost'), params('not-a-uuid'))
    expect(res.status).toBe(404)
    expect(mocks.contactLookup).not.toHaveBeenCalled()
  })

  it('signing failure → 503, never the storage path in the body', async () => {
    storedContact({ id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: PATH })
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await GET(new Request('http://localhost'), params(CONTACT))
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain(PATH)
  })
})
