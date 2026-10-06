import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  sync: vi.fn(),
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  checkRateLimit: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  queries: [] as { client: string; table: string; eq: Record<string, unknown>; in: Record<string, unknown[]> }[],
}))

/** Minimal PostgREST-like fake: select + eq + in, filtering rows of an in-memory table. */
function fakeClient(client: string) {
  return {
    from(table: string) {
      const q = { client, table, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown[]> }
      mocks.queries.push(q)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        q.eq[col] = val
        return b
      }
      b.in = (col: string, vals: unknown[]) => {
        q.in[col] = vals
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        const rows = (mocks.tables[table] ?? []).filter(
          (r) =>
            Object.entries(q.eq).every(([k, v]) => r[k] === v) &&
            Object.entries(q.in).every(([k, vs]) => vs.includes(r[k])),
        )
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      }
      return b
    },
  }
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeClient('admin') }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mocks.decrypt }))
vi.mock('@/lib/whatsapp/contact-avatar-sync', () => ({ syncContactWhatsAppAvatar: mocks.sync }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  RATE_LIMITS: { avatarSyncAccount: { limit: 20, windowMs: 60_000 } },
}))

import { POST } from './route'
import { AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST } from '@/lib/inbox/contact-avatar-sync-shared'

const ACCOUNT = '11111111-1111-1111-1111-111111111111'
const OTHER_ACCOUNT = '99999999-9999-9999-9999-999999999999'
const id = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`
const CONV = { A: id(1), B: id(2), C: id(3), D: id(4), E: id(5), F: id(6), X: id(9) }
const CONTACT = { A: id(101), B: id(102), C: id(103), D: id(104), X: id(109) }
const CONFIG = { UAZ_1: id(201), UAZ_2: id(202), META: id(203), FOREIGN: id(209) }
const HASH = 'cd'.repeat(32)

function conv(convId: string, contactId: string, configId: string | null, account = ACCOUNT, phone = '+55 (91) 99999-0001') {
  return { id: convId, account_id: account, whatsapp_config_id: configId, contact: { id: contactId, account_id: account, phone } }
}

function seed() {
  mocks.tables.conversations = [
    conv(CONV.A, CONTACT.A, CONFIG.UAZ_1),
    conv(CONV.B, CONTACT.B, CONFIG.UAZ_2, ACCOUNT, '5591999990002'),
    conv(CONV.C, CONTACT.C, null),
    conv(CONV.D, CONTACT.D, CONFIG.META),
    conv(CONV.E, CONTACT.A, CONFIG.UAZ_1), // same contact as A
    conv(CONV.X, CONTACT.X, CONFIG.FOREIGN, OTHER_ACCOUNT),
  ]
  mocks.tables.whatsapp_config = [
    { id: CONFIG.UAZ_1, account_id: ACCOUNT, provider: 'uazapi', uazapi_instance_token: 'enc-token-1' },
    { id: CONFIG.UAZ_2, account_id: ACCOUNT, provider: 'uazapi', uazapi_instance_token: 'enc-token-2' },
    { id: CONFIG.META, account_id: ACCOUNT, provider: 'meta', uazapi_instance_token: null },
    { id: CONFIG.FOREIGN, account_id: OTHER_ACCOUNT, provider: 'uazapi', uazapi_instance_token: 'enc-foreign' },
  ]
  mocks.tables.contacts = [
    { id: CONTACT.A, account_id: ACCOUNT, whatsapp_avatar_path: `${ACCOUNT}/contacts/${CONTACT.A}/${HASH}.jpg`, whatsapp_avatar_checked_at: '2026-10-06T12:00:00.000Z' },
    { id: CONTACT.B, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: '2026-10-06T12:00:00.000Z' },
    { id: CONTACT.C, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: null },
    { id: CONTACT.D, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: null },
    { id: CONTACT.X, account_id: OTHER_ACCOUNT, whatsapp_avatar_path: 'secret', whatsapp_avatar_checked_at: null },
  ]
}

function post(body: unknown) {
  return POST(new Request('http://localhost/api/contacts/avatar-sync', { method: 'POST', body: JSON.stringify(body) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queries.length = 0
  seed()
  mocks.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: 'user-1', role: 'agent', supabase: fakeClient('rls') })
  mocks.checkRateLimit.mockResolvedValue({ success: true, remaining: 19, reset: Date.now() + 60_000, limit: 20 })
  mocks.sync.mockResolvedValue('updated')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/contacts/avatar-sync — auth, input and isolation', () => {
  it('no session: rejected before any lookup or sync', async () => {
    mocks.requireRole.mockRejectedValue({ status: 401, message: 'Unauthorized' })
    const res = await post({ conversationIds: [CONV.A] })
    expect(res.status).toBe(401)
    expect(mocks.queries).toHaveLength(0)
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('requires at least the viewer role', async () => {
    await post({ conversationIds: [CONV.A] })
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer')
  })

  it.each([
    ['missing ids', {}],
    ['empty list', { conversationIds: [] }],
    ['non-uuid', { conversationIds: ['x'] }],
    ['above the internal batch limit', { conversationIds: Array.from({ length: AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST + 1 }, (_, i) => id(500 + i)) }],
  ])('400 for %s — nothing queried', async (_label, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(mocks.queries).toHaveLength(0)
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('accepts exactly the internal batch limit', async () => {
    const ids = [CONV.A, CONV.B, CONV.C, CONV.D, CONV.F]
    expect(ids).toHaveLength(AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST)
    expect((await post({ conversationIds: ids })).status).toBe(200)
  })

  it('conversations are read with the RLS client AND an explicit account_id filter', async () => {
    await post({ conversationIds: [CONV.A] })
    const convQuery = mocks.queries.find((q) => q.table === 'conversations')!
    expect(convQuery.client).toBe('rls')
    expect(convQuery.eq.account_id).toBe(ACCOUNT)
    for (const q of mocks.queries.filter((x) => x.table !== 'conversations')) expect(q.eq.account_id).toBe(ACCOUNT)
  })

  it('a conversation of another account is not_found: no sync, no avatar state, nothing leaked', async () => {
    const res = await post({ conversationIds: [CONV.X] })
    const body = await res.json()
    expect(body.results).toEqual([{ conversationId: CONV.X, contactId: null, status: 'not_found', avatar: null }])
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('POST /api/contacts/avatar-sync — connection rules', () => {
  it('whatsapp_config_id NULL: skipped, never the primary connection, no sync', async () => {
    const body = await (await post({ conversationIds: [CONV.C] })).json()
    expect(body.results[0]).toMatchObject({ conversationId: CONV.C, contactId: CONTACT.C, status: 'skipped_no_connection' })
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('provider other than uazapi: skipped, no sync', async () => {
    const body = await (await post({ conversationIds: [CONV.D] })).json()
    expect(body.results[0]).toMatchObject({ status: 'skipped_provider' })
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('uses EACH conversation\'s own connection token, the stored phone digits (no JID), background mode', async () => {
    await post({ conversationIds: [CONV.A, CONV.B] })
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    const [a, b] = mocks.sync.mock.calls.map((c) => c[0])
    expect(a).toMatchObject({ accountId: ACCOUNT, contactId: CONTACT.A, chatId: '5591999990001', mode: 'background' })
    expect(b).toMatchObject({ accountId: ACCOUNT, contactId: CONTACT.B, chatId: '5591999990002', mode: 'background' })
    expect(a.chatId).not.toContain('@')
    await expect(a.getInstanceToken()).resolves.toBe('decrypted:enc-token-1')
    await expect(b.getInstanceToken()).resolves.toBe('decrypted:enc-token-2')
  })

  it('the same contact in two conversations of a batch is queried once', async () => {
    const body = await (await post({ conversationIds: [CONV.A, CONV.E] })).json()
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['updated', 'updated'])
  })
})

describe('POST /api/contacts/avatar-sync — outcomes returned to the UI', () => {
  it.each(['fresh', 'updated', 'no_photo', 'no_photo_kept', 'transient_error'] as const)(
    '%s: returns the contact\'s current avatar as an opaque version (never the storage path)',
    async (status) => {
      mocks.sync.mockResolvedValue(status)
      const body = await (await post({ conversationIds: [CONV.A] })).json()
      expect(body.throttled).toBe(false)
      expect(body.results[0]).toEqual({
        conversationId: CONV.A,
        contactId: CONTACT.A,
        status,
        avatar: { version: HASH.slice(0, 16), checkedAt: '2026-10-06T12:00:00.000Z' },
      })
      expect(JSON.stringify(body)).not.toContain('/contacts/')
    },
  )

  it('no photo: version null', async () => {
    mocks.sync.mockResolvedValue('no_photo')
    const body = await (await post({ conversationIds: [CONV.B] })).json()
    expect(body.results[0].avatar).toEqual({ version: null, checkedAt: '2026-10-06T12:00:00.000Z' })
  })

  it('UAZAPI 429 (throttled): stops the rest of the batch and answers throttled', async () => {
    mocks.sync.mockResolvedValueOnce('throttled')
    mocks.tables.conversations.push(conv(CONV.F, CONTACT.B, CONFIG.UAZ_1))
    const body = await (await post({ conversationIds: [CONV.A, CONV.B, CONV.F] })).json()
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    expect(body.throttled).toBe(true)
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['throttled', 'not_processed', 'not_processed'])
  })

  it('our own shared rate limit exceeded: 429 throttled, nothing queried or synced', async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000, limit: 20 })
    const res = await post({ conversationIds: [CONV.A] })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ throttled: true, results: [] })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(`avatar-sync:${ACCOUNT}`, { limit: 20, windowMs: 60_000 })
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
