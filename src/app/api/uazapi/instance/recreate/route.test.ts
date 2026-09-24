import { beforeEach, describe, expect, it, vi } from 'vitest'

// ETAPA 078A-PREP — RECRIAR uma conexão UAZAPI é UPDATE in-place da
// mesma linha whatsapp_config: preserva id/account_id/provider, nunca
// insere nem apaga (compatível com a FK NO ACTION da 078A) e não passa
// pelo gate de multiconexão.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createInstance: vi.fn(),
  getInstanceStatus: vi.fn(),
  checkNewConnectionAllowed: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/whatsapp/uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/uazapi-api')>()
  return {
    UazapiHttpError: actual.UazapiHttpError,
    createInstance: mocks.createInstance,
    getInstanceStatus: mocks.getInstanceStatus,
  }
})

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => {
    if (v === 'corrupted') throw new Error('bad key')
    return `dec:${v}`
  }),
}))

// Would block a NEW connection if it were ever consulted.
vi.mock('@/lib/whatsapp/connection-gate', () => ({
  checkNewConnectionAllowed: mocks.checkNewConnectionAllowed,
}))

import { UazapiHttpError } from '@/lib/whatsapp/uazapi-api'
import { POST } from './route'

const CONFIG_ID = '11111111-2222-4333-8444-555555555555'
const ACCOUNT = { id: 'acct-1', name: 'Acme' }

type Row = Record<string, unknown> | null

function supabaseStub(row: Row, opts: { updatedRows?: number; updateError?: { message: string } } = {}) {
  const calls = {
    lookupFilters: [] as [string, unknown][],
    updates: [] as Record<string, unknown>[],
    updateFilters: [] as [string, string, unknown][],
    inserts: 0,
    deletes: 0,
  }
  const from = vi.fn(() => {
    const select: Record<string, unknown> = {}
    select.eq = vi.fn((col: string, val: unknown) => {
      calls.lookupFilters.push([col, val])
      return select
    })
    select.maybeSingle = vi.fn(async () => ({ data: row, error: null }))

    const update: Record<string, unknown> = {}
    update.eq = vi.fn((col: string, val: unknown) => {
      calls.updateFilters.push(['eq', col, val])
      return update
    })
    update.is = vi.fn((col: string, val: unknown) => {
      calls.updateFilters.push(['is', col, val])
      return update
    })
    update.select = vi.fn(async () =>
      opts.updateError
        ? { data: null, error: opts.updateError }
        : { data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: CONFIG_ID })), error: null },
    )

    return {
      select: vi.fn(() => select),
      update: vi.fn((payload: Record<string, unknown>) => {
        calls.updates.push(payload)
        return update
      }),
      insert: vi.fn(() => {
        calls.inserts++
        throw new Error('recreate must never insert')
      }),
      delete: vi.fn(() => {
        calls.deletes++
        throw new Error('recreate must never delete')
      }),
    }
  })
  return { client: { from }, calls }
}

function req(body: unknown) {
  return new Request('http://localhost/api/uazapi/instance/recreate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const UAZAPI_ROW = {
  id: CONFIG_ID,
  account_id: 'acct-1',
  provider: 'uazapi',
  uazapi_instance_id: 'inst-old',
  uazapi_instance_token: 'tok-old',
  uazapi_instance_name: 'Acme',
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.createInstance.mockResolvedValue({ instanceId: 'inst-new', instanceToken: 'tok-new' })
  mocks.getInstanceStatus.mockRejectedValue(new UazapiHttpError(401, 'unauthorized'))
  mocks.checkNewConnectionAllowed.mockResolvedValue({
    allowed: false,
    reason: 'multi_connection_disabled',
    connectionCount: 1,
  })
})

function asAdmin(client: unknown) {
  mocks.requireRole.mockResolvedValue({ supabase: client, userId: 'u1', accountId: 'acct-1', account: ACCOUNT })
}

describe('POST /api/uazapi/instance/recreate', () => {
  it('recreates in place: same whatsapp_config.id, new instance id/token, no new row, gate not consulted', async () => {
    const { client, calls } = supabaseStub(UAZAPI_ROW)
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, configId: CONFIG_ID, provider: 'uazapi', recreated: true })
    expect(calls.inserts).toBe(0)
    expect(calls.deletes).toBe(0)
    expect(calls.updates).toHaveLength(1)
    expect(calls.updates[0]).toMatchObject({
      uazapi_instance_id: 'inst-new',
      uazapi_instance_token: 'enc:tok-new',
      status: 'disconnected',
      connected_at: null,
    })
    // Never rewrites identity/tenancy/provider or Meta fields.
    for (const key of ['id', 'account_id', 'provider', 'phone_number_id', 'access_token', 'waba_id']) {
      expect(calls.updates[0]).not.toHaveProperty(key)
    }
    // Scoped to the exact row + account + provider + old instance (optimistic).
    expect(calls.updateFilters).toEqual([
      ['eq', 'id', CONFIG_ID],
      ['eq', 'account_id', 'acct-1'],
      ['eq', 'provider', 'uazapi'],
      ['eq', 'uazapi_instance_id', 'inst-old'],
    ])
    expect(calls.lookupFilters).toEqual([
      ['id', CONFIG_ID],
      ['account_id', 'acct-1'],
    ])
    expect(mocks.checkNewConnectionAllowed).not.toHaveBeenCalled()
  })

  it('legacy row with dormant Meta credentials: recreated in place, Meta fields untouched', async () => {
    const { client, calls } = supabaseStub({
      ...UAZAPI_ROW,
      phone_number_id: 'pn-legacy',
      access_token: 'enc-meta',
      waba_id: 'waba-1',
    })
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(200)
    expect(calls.updates[0]).not.toHaveProperty('phone_number_id')
    expect(calls.updates[0]).not.toHaveProperty('access_token')
    expect(calls.updates[0]).not.toHaveProperty('waba_id')
    expect(calls.updates[0]).not.toHaveProperty('provider')
    expect(calls.inserts + calls.deletes).toBe(0)
  })

  it('refuses to recreate a still-valid instance (would silently disconnect a working number)', async () => {
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected' })
    const { client, calls } = supabaseStub(UAZAPI_ROW)
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('instance_still_valid')
    expect(mocks.createInstance).not.toHaveBeenCalled()
    expect(calls.updates).toHaveLength(0)
  })

  it('transient UAZAPI failure while verifying → 502, nothing created or written', async () => {
    mocks.getInstanceStatus.mockRejectedValue(new Error('network'))
    const { client, calls } = supabaseStub(UAZAPI_ROW)
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(502)
    expect(mocks.createInstance).not.toHaveBeenCalled()
    expect(calls.updates).toHaveLength(0)
  })

  it('no usable token (missing or undecryptable) counts as invalid → recreates', async () => {
    const { client, calls } = supabaseStub({ ...UAZAPI_ROW, uazapi_instance_token: 'corrupted' })
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(200)
    expect(mocks.getInstanceStatus).not.toHaveBeenCalled()
    expect(calls.updates).toHaveLength(1)
  })

  it('row without an instance id uses IS NULL for the optimistic filter', async () => {
    const { client, calls } = supabaseStub({ ...UAZAPI_ROW, uazapi_instance_id: null, uazapi_instance_token: null })
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(200)
    expect(calls.updateFilters).toContainEqual(['is', 'uazapi_instance_id', null])
  })

  it('external createInstance failure leaves the config untouched', async () => {
    mocks.createInstance.mockRejectedValue(new Error('boom'))
    const { client, calls } = supabaseStub(UAZAPI_ROW)
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(502)
    expect(calls.updates).toHaveLength(0)
    expect(calls.inserts + calls.deletes).toBe(0)
  })

  it('concurrent recreate (0 rows updated) → 409, no overwrite', async () => {
    const { client } = supabaseStub(UAZAPI_ROW, { updatedRows: 0 })
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(409)
  })

  it('config of another account / unknown id → 404, nothing created', async () => {
    const { client } = supabaseStub(null)
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(404)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('Meta connection → 400 (recreate is UAZAPI-only), nothing created', async () => {
    const { client } = supabaseStub({ ...UAZAPI_ROW, provider: 'meta' })
    asAdmin(client)

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(400)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('requires an explicit, well-formed config_id', async () => {
    const { client } = supabaseStub(UAZAPI_ROW)
    asAdmin(client)

    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req({ config_id: 'not-a-uuid' }))).status).toBe(400)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('non-admin never reaches the lookup', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: 'Forbidden' })

    const res = await POST(req({ config_id: CONFIG_ID }))

    expect(res.status).toBe(403)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })
})
