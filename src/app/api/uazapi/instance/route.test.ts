import { beforeEach, describe, expect, it, vi } from 'vitest'

// ETAPA 077B — POST no longer looks up "the account's instance": every
// call provisions a brand-new external UAZAPI instance and inserts its
// own independent row. These tests lock in that there's no lookup, no
// idempotent no-op, and no upgrade-in-place of an existing (Meta or
// UAZAPI) row — plus DELETE's existing primary-row-scoped behavior,
// unchanged from ETAPA 077A.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createInstance: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  loadPrimaryWhatsAppConfigRow: vi.fn(),
  checkNewConnectionAllowed: vi.fn(),
}))

vi.mock('@/lib/account/admin-client', () => ({
  supabaseAdmin: vi.fn(() => ({ admin: true })),
}))

vi.mock('@/lib/whatsapp/connection-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/connection-gate')>()
  return { ...actual, checkNewConnectionAllowed: mocks.checkNewConnectionAllowed }
})

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  createInstance: mocks.createInstance,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: mocks.encrypt,
  decrypt: mocks.decrypt,
}))

vi.mock('@/lib/whatsapp/active-config', () => ({
  loadPrimaryWhatsAppConfigRow: mocks.loadPrimaryWhatsAppConfigRow,
}))

import { DELETE, POST } from './route'

const ACCOUNT = { id: 'acct-1', name: 'Acme' }

/** Records every `.insert()` payload so a test can assert on it
 *  without caring about the rest of the chain. */
function supabaseStub(
  opts: {
    insertError?: { code?: string; message: string } | null
    deleteError?: { code?: string; message: string } | null
  } = {},
) {
  const insertedRows: Record<string, unknown>[] = []
  const insertBuilder: Record<string, unknown> = {}
  insertBuilder.select = vi.fn(() => insertBuilder)
  insertBuilder.single = vi.fn(async () => {
    if (opts.insertError) return { data: null, error: opts.insertError }
    return { data: { id: 'cfg-new' }, error: null }
  })

  const updateBuilder: Record<string, unknown> = {}
  updateBuilder.eq = vi.fn(() => updateBuilder)
  updateBuilder.select = vi.fn(async () => ({ data: [{ id: 'cfg-existing' }], error: null }))

  const deleteBuilder: Record<string, unknown> = {}
  deleteBuilder.eq = vi.fn(() => deleteBuilder)
  deleteBuilder.select = vi.fn(async () =>
    opts.deleteError
      ? { data: null, error: opts.deleteError }
      : { data: [{ id: 'cfg-existing' }], error: null },
  )

  return {
    insertedRows,
    from: vi.fn(() => ({
      insert: vi.fn((payload: Record<string, unknown>) => {
        insertedRows.push(payload)
        return insertBuilder
      }),
      update: vi.fn(() => updateBuilder),
      delete: vi.fn(() => deleteBuilder),
    })),
  }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.createInstance.mockReset()
  mocks.encrypt.mockReset()
  mocks.decrypt.mockReset()
  mocks.loadPrimaryWhatsAppConfigRow.mockReset()
  mocks.encrypt.mockImplementation((v: string) => `encrypted:${v}`)
  mocks.decrypt.mockImplementation((v: string) => `decrypted:${v}`)
  mocks.createInstance.mockResolvedValue({ instanceId: 'inst-new', instanceToken: 'raw-token' })
  mocks.checkNewConnectionAllowed.mockReset()
  mocks.checkNewConnectionAllowed.mockResolvedValue({
    allowed: true,
    connectionCount: 0,
    multiConnectionEnabled: false,
  })
})

describe('POST /api/uazapi/instance — ETAPA 078-0 multi-connection gate', () => {
  it('flag off + zero connections: first connection is created', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()

    expect(res.status).toBe(200)
    expect(mocks.checkNewConnectionAllowed).toHaveBeenCalledWith({ admin: true }, 'acct-1')
    expect(mocks.createInstance).toHaveBeenCalledTimes(1)
    expect(supabase.insertedRows).toHaveLength(1)
  })

  it('flag off + one connection: blocked with 409 BEFORE createInstance, nothing written', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'multi_connection_disabled',
      connectionCount: 1,
    })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json).toEqual({
      error: 'Multiple WhatsApp connections are not enabled for this account.',
      code: 'multi_connection_disabled',
    })
    expect(mocks.createInstance).not.toHaveBeenCalled()
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('gate lookup failure fails closed: 500, no external call, nothing written', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.checkNewConnectionAllowed.mockResolvedValue({ allowed: false, reason: 'lookup_failed' })

    const res = await POST()

    expect(res.status).toBe(500)
    expect(mocks.createInstance).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('flag on + one connection: second connection is created', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: true,
      connectionCount: 1,
      multiConnectionEnabled: true,
    })

    const res = await POST()

    expect(res.status).toBe(200)
    expect(mocks.createInstance).toHaveBeenCalledTimes(1)
    expect(supabase.insertedRows).toHaveLength(1)
  })

  it('role check runs before the gate — a non-admin never reaches it', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: 'Forbidden' })

    const res = await POST()

    expect(res.status).toBe(403)
    expect(mocks.checkNewConnectionAllowed).not.toHaveBeenCalled()
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/uazapi/instance — ETAPA 078-0 does not gate existing-connection maintenance', () => {
  it('never consults the multi-connection gate', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({
      id: 'cfg-existing',
      account_id: 'acct-1',
      status: 'connected',
      created_at: '2026-01-01',
      provider: 'uazapi',
      phone_number_id: null,
      access_token: null,
    })

    const res = await DELETE()

    expect(res.status).toBe(200)
    expect(mocks.checkNewConnectionAllowed).not.toHaveBeenCalled()
  })
})

describe('POST /api/uazapi/instance — always creates a new, independent connection', () => {
  it('provisions a UAZAPI instance and inserts it as a brand-new row, no existing-row lookup at all', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, provider: 'uazapi', configId: 'cfg-new' })
    expect(mocks.createInstance).toHaveBeenCalledTimes(1)
    expect(supabase.insertedRows).toHaveLength(1)
    expect(supabase.insertedRows[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      provider: 'uazapi',
      uazapi_instance_id: 'inst-new',
      uazapi_instance_token: 'encrypted:raw-token',
      status: 'disconnected',
    })
  })

  it('creates a second, independent instance for an account that already has one (once multi-connection is enabled)', async () => {
    // No 23505 this time — simulates the post-migration-077 world where
    // whatsapp_config_account_id_key no longer blocks a second row.
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.createInstance.mockResolvedValue({ instanceId: 'inst-second', instanceToken: 'raw-token-2' })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(supabase.insertedRows[0].uazapi_instance_id).toBe('inst-second')
  })

  it('returns an honest 409 (not a generic retry message) when whatsapp_config_account_id_key still blocks a second row', async () => {
    const supabase = supabaseStub({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "whatsapp_config_account_id_key"' } })
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/already has a WhatsApp connection/i)
    expect(json.error).not.toMatch(/constraint|duplicate key/i)
  })

  it('returns a phone_number_id-specific 409, not the account-cardinality message, when that constraint fires', async () => {
    // Post-077 world: whatsapp_config_account_id_key is gone, so a
    // 23505 here can only be some other constraint — this locks in
    // that the handler does not fall back to assuming "account
    // already has a connection" once that constraint no longer exists.
    const supabase = supabaseStub({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "whatsapp_config_phone_number_id_key"' } })
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/number/i)
    expect(json.error).not.toMatch(/already has a WhatsApp connection/i)
  })

  it('returns a generic conflict, not the account-cardinality message, for an unrecognized unique violation', async () => {
    const supabase = supabaseStub({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "whatsapp_config_pkey"' } })
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).not.toMatch(/already has a WhatsApp connection|phone/i)
  })

  it('returns 502 when the external UAZAPI call fails, before ever touching the database', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.createInstance.mockRejectedValue(new Error('network down'))

    const res = await POST()
    expect(res.status).toBe(502)
    expect(supabase.insertedRows).toHaveLength(0)
  })

  it('returns 500 on a non-23505 insert failure', async () => {
    const supabase = supabaseStub({ insertError: { message: 'db is on fire' } })
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })

    const res = await POST()
    expect(res.status).toBe(500)
  })

  it('propagates a role-check failure before ever calling createInstance', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: 'forbidden' })
    const res = await POST()
    expect(res.status).toBe(403)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/uazapi/instance — still scoped to the resolved primary row', () => {
  it('404s when the account has no config at all', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: supabaseStub(), accountId: 'acct-1' })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue(null)

    const res = await DELETE()
    expect(res.status).toBe(404)
  })

  it('400s when the resolved primary row is not UAZAPI', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: supabaseStub(), accountId: 'acct-1' })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({ id: 'cfg-1', provider: 'meta' })

    const res = await DELETE()
    expect(res.status).toBe(400)
  })

  it('deletes the row outright when there are no dormant Meta credentials', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1' })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({
      id: 'cfg-1',
      provider: 'uazapi',
      phone_number_id: null,
      access_token: null,
    })

    const res = await DELETE()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.restored_meta).toBe(false)
  })

  it('restores dormant Meta credentials on a legacy row instead of deleting it', async () => {
    const supabase = supabaseStub()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1' })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({
      id: 'cfg-1',
      provider: 'uazapi',
      phone_number_id: 'pn-1',
      access_token: 'enc-token',
    })

    const res = await DELETE()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.restored_meta).toBe(true)
    expect(json.provider).toBe('meta')
  })
})

describe('DELETE /api/uazapi/instance — ETAPA 078A-PREP', () => {
  it('maps a 23503 (connection referenced by conversations, 078A FK) to a clear 409', async () => {
    const supabase = supabaseStub({ deleteError: { code: '23503', message: 'fk' } })
    mocks.requireRole.mockResolvedValue({ supabase, userId: 'user-1', accountId: 'acct-1', account: ACCOUNT })
    mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({
      id: 'cfg-existing',
      account_id: 'acct-1',
      status: 'disconnected',
      created_at: '2026-01-01',
      provider: 'uazapi',
      phone_number_id: null,
      access_token: null,
    })

    const res = await DELETE()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('connection_has_history')
  })
})
