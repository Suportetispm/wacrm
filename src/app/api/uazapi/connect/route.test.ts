import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadActiveWhatsAppConfig: vi.fn(),
  connectInstance: vi.fn(),
  ensureUazapiWebhookRegistered: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
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
    connectInstance: mocks.connectInstance,
  }
})

vi.mock('@/lib/whatsapp/uazapi-webhook-register', () => ({
  ensureUazapiWebhookRegistered: mocks.ensureUazapiWebhookRegistered,
}))

import { POST } from './route'

/** Chainable `.update().eq().eq().select()` mock for the best-effort
 *  status mirror — mirrors the style used in existing route tests. */
function supabaseStub() {
  const builder: Record<string, unknown> = {}
  builder.update = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.select = vi.fn(() => ({ data: [{ id: 'row-1' }], error: null }))
  return { from: vi.fn(() => builder) }
}

const CONFIG_CONNECTING = {
  provider: 'uazapi' as const,
  instanceToken: 'token-A',
  configId: 'cfg-A',
  uazapiInstanceId: 'inst-A',
}

function ctxWith() {
  return { supabase: supabaseStub(), accountId: 'acct-A' }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.loadActiveWhatsAppConfig.mockReset()
  mocks.connectInstance.mockReset()
  mocks.ensureUazapiWebhookRegistered.mockReset()
  mocks.requireRole.mockResolvedValue(ctxWith())
  mocks.loadActiveWhatsAppConfig.mockResolvedValue(CONFIG_CONNECTING)
  mocks.ensureUazapiWebhookRegistered.mockResolvedValue({ ok: true })
})

describe('POST /api/uazapi/connect — automatic webhook registration', () => {
  it('does NOT trigger registration when the QR flow starts (status "connecting")', async () => {
    mocks.connectInstance.mockResolvedValue({ status: 'connecting', qrcode: 'data:...', paircode: '123-456' })

    const res = await POST()

    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).not.toHaveBeenCalled()
  })

  it('triggers registration when connect resolves straight to "connected" (resumed session)', async () => {
    mocks.connectInstance.mockResolvedValue({ status: 'connected' })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('connected')
    expect(mocks.ensureUazapiWebhookRegistered).toHaveBeenCalledWith({
      instanceId: 'inst-A',
      instanceToken: 'token-A',
    })
  })

  it('skips registration when uazapiInstanceId is missing, without erroring', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue({ ...CONFIG_CONNECTING, uazapiInstanceId: null })
    mocks.connectInstance.mockResolvedValue({ status: 'connected' })

    const res = await POST()

    expect(res.status).toBe(200)
    expect(mocks.ensureUazapiWebhookRegistered).not.toHaveBeenCalled()
  })

  it('a registration failure never changes the connect response (connection is not treated as broken)', async () => {
    mocks.connectInstance.mockResolvedValue({ status: 'connected' })
    mocks.ensureUazapiWebhookRegistered.mockResolvedValue({ ok: false, reason: 'no_production_origin' })

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('connected')
  })

  it('ensureUazapiWebhookRegistered throwing unexpectedly still returns the normal 200 response', async () => {
    mocks.connectInstance.mockResolvedValue({ status: 'connected' })
    mocks.ensureUazapiWebhookRegistered.mockRejectedValue(new Error('boom'))

    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('connected')
  })
})
