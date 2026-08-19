import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadActiveWhatsAppConfig: vi.fn(),
  getInstanceStatus: vi.fn(),
  ensureUazapiWebhookRegistered: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/whatsapp/active-config', () => ({
  loadActiveWhatsAppConfig: mocks.loadActiveWhatsAppConfig,
}))

vi.mock('@/lib/whatsapp/uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/uazapi-api')>()
  return {
    ...actual,
    getInstanceStatus: mocks.getInstanceStatus,
  }
})

vi.mock('@/lib/whatsapp/uazapi-webhook-register', () => ({
  ensureUazapiWebhookRegistered: mocks.ensureUazapiWebhookRegistered,
}))

import { GET } from './route'

/** `select('status')` (pre-existing "was it already connected"
 *  read) and `update(...).select('id')` (the mirror write) hit the
 *  same table via different chains — dispatched by which top-level
 *  method was called. */
function supabaseStub(opts: { currentDbStatus?: string | null } = {}) {
  const selectBuilder: Record<string, unknown> = {}
  selectBuilder.eq = vi.fn(() => selectBuilder)
  selectBuilder.maybeSingle = vi.fn(async () => ({
    data: opts.currentDbStatus !== undefined && opts.currentDbStatus !== null
      ? { status: opts.currentDbStatus }
      : null,
    error: null,
  }))

  const updateBuilder: Record<string, unknown> = {}
  updateBuilder.eq = vi.fn(() => updateBuilder)
  updateBuilder.select = vi.fn(() => ({ data: [{ id: 'row-1' }], error: null }))

  return {
    from: vi.fn(() => ({
      select: vi.fn(() => selectBuilder),
      update: vi.fn(() => updateBuilder),
    })),
  }
}

const CONFIG_A = {
  provider: 'uazapi' as const,
  instanceToken: 'token-A',
  configId: 'cfg-A',
  uazapiInstanceId: 'inst-A',
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.loadActiveWhatsAppConfig.mockReset()
  mocks.getInstanceStatus.mockReset()
  mocks.ensureUazapiWebhookRegistered.mockReset()
  mocks.getCurrentAccount.mockResolvedValue({ supabase: supabaseStub(), accountId: 'acct-A' })
  mocks.loadActiveWhatsAppConfig.mockResolvedValue(CONFIG_A)
  mocks.ensureUazapiWebhookRegistered.mockResolvedValue({ ok: true })
})

describe('GET /api/uazapi/status — automatic webhook registration', () => {
  it('does not register while still "connecting"', async () => {
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connecting', connected: false, loggedIn: false })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).not.toHaveBeenCalled()
  })

  it('registers on the transition into "connected" (DB previously not connected)', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: supabaseStub({ currentDbStatus: 'connecting' }),
      accountId: 'acct-A',
    })
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true, loggedIn: true })

    const res = await GET()

    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).toHaveBeenCalledWith({
      instanceId: 'inst-A',
      instanceToken: 'token-A',
    })
  })

  it('self-heal: also registers when the DB already says "connected" (not just on the transition edge)', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: supabaseStub({ currentDbStatus: 'connected' }),
      accountId: 'acct-A',
    })
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true, loggedIn: true })

    const res = await GET()

    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).toHaveBeenCalledTimes(1)
  })

  it('skips registration when uazapiInstanceId is missing', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue({ ...CONFIG_A, uazapiInstanceId: null })
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true, loggedIn: true })

    const res = await GET()

    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).not.toHaveBeenCalled()
  })

  it('a registration failure never changes the status response', async () => {
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true, loggedIn: true })
    mocks.ensureUazapiWebhookRegistered.mockResolvedValue({ ok: false, reason: 'no_production_origin' })

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('connected')
  })

  it('ensureUazapiWebhookRegistered throwing unexpectedly still returns the normal 200 response', async () => {
    mocks.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true, loggedIn: true })
    mocks.ensureUazapiWebhookRegistered.mockRejectedValue(new Error('boom'))

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('connected')
  })
})
