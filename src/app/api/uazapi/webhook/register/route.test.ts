import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadActiveWhatsAppConfig: vi.fn(),
  resolveConfiguredSiteOrigin: vi.fn(),
  registerUazapiWebhook: vi.fn(),
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

vi.mock('@/lib/whatsapp/uazapi-webhook-register', () => ({
  maskInstanceId: (id: string) => `masked-${id}`,
  resolveConfiguredSiteOrigin: mocks.resolveConfiguredSiteOrigin,
  registerUazapiWebhook: mocks.registerUazapiWebhook,
}))

import { POST } from './route'

function postRequest(body?: unknown) {
  return new Request('http://localhost/api/uazapi/webhook/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function malformedRequest() {
  return new Request('http://localhost/api/uazapi/webhook/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  })
}

const CTX_A = { supabase: {}, accountId: 'acct-A' }
const CONFIG_A = { provider: 'uazapi' as const, instanceToken: 'token-A', configId: 'cfg-A', uazapiInstanceId: 'inst-A' }

const CTX_B = { supabase: {}, accountId: 'acct-B' }
const CONFIG_B = { provider: 'uazapi' as const, instanceToken: 'token-B', configId: 'cfg-B', uazapiInstanceId: 'inst-B' }

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.loadActiveWhatsAppConfig.mockReset()
  mocks.resolveConfiguredSiteOrigin.mockReset()
  mocks.registerUazapiWebhook.mockReset()
  mocks.requireRole.mockResolvedValue(CTX_A)
  mocks.loadActiveWhatsAppConfig.mockResolvedValue(CONFIG_A)
  mocks.registerUazapiWebhook.mockResolvedValue({ ok: true })
})

describe('POST /api/uazapi/webhook/register — production origin (NEXT_PUBLIC_SITE_URL configured)', () => {
  beforeEach(() => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: true, origin: 'https://spmticket.com.br' })
  })

  it('uses the configured origin and ignores an arbitrary client-supplied baseUrl entirely', async () => {
    const res = await POST(postRequest({ baseUrl: 'https://evil.example.com' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true })
    expect(mocks.registerUazapiWebhook).toHaveBeenCalledWith({
      instanceToken: 'token-A',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'inst-A',
    })
  })

  it('succeeds with no body at all — production mode never requires baseUrl', async () => {
    const res = await POST(postRequest())
    expect(res.status).toBe(200)
    expect(mocks.registerUazapiWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ baseOrigin: 'https://spmticket.com.br' }),
    )
  })

  it('succeeds even with a malformed JSON body — the body is never read in production mode', async () => {
    const res = await POST(malformedRequest())
    expect(res.status).toBe(200)
    expect(mocks.registerUazapiWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ baseOrigin: 'https://spmticket.com.br' }),
    )
  })

  it('500s with site_url_misconfigured when the configured value is set but invalid — never falls back to the dev path', async () => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: false, reason: 'invalid' })

    const res = await POST(postRequest({ baseUrl: 'https://foo.trycloudflare.com' }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'site_url_misconfigured' })
    expect(mocks.registerUazapiWebhook).not.toHaveBeenCalled()
  })
})

describe('POST /api/uazapi/webhook/register — dev tunnel fallback (NEXT_PUBLIC_SITE_URL unset)', () => {
  beforeEach(() => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: false, reason: 'unset' })
  })

  it('rejects when no baseUrl is supplied', async () => {
    const res = await POST(postRequest({}))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json).toEqual({ error: 'invalid_base_url' })
    expect(mocks.registerUazapiWebhook).not.toHaveBeenCalled()
  })

  it('rejects a non-trycloudflare.com domain sent by the client', async () => {
    const res = await POST(postRequest({ baseUrl: 'https://spmticket.com.br' }))
    expect(res.status).toBe(400)
    expect(mocks.registerUazapiWebhook).not.toHaveBeenCalled()
  })

  it('accepts a valid *.trycloudflare.com tunnel URL', async () => {
    const res = await POST(postRequest({ baseUrl: 'https://abc-def.trycloudflare.com' }))
    expect(res.status).toBe(200)
    expect(mocks.registerUazapiWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ baseOrigin: 'https://abc-def.trycloudflare.com' }),
    )
  })
})

describe('POST /api/uazapi/webhook/register — config validation', () => {
  beforeEach(() => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: true, origin: 'https://spmticket.com.br' })
  })

  it('400s uazapi_not_configured when there is no config at all', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue(null)
    const res = await POST(postRequest())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('uazapi_not_configured')
  })

  it('400s uazapi_not_configured for a meta-provider config', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue({ provider: 'meta', configId: 'cfg-A' })
    const res = await POST(postRequest())
    expect(res.status).toBe(400)
  })

  it('400s uazapi_not_configured when uazapiInstanceId is null (partial/broken config)', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue({ ...CONFIG_A, uazapiInstanceId: null })
    const res = await POST(postRequest())
    expect(res.status).toBe(400)
    expect(mocks.registerUazapiWebhook).not.toHaveBeenCalled()
  })
})

describe('POST /api/uazapi/webhook/register — external failure mapping', () => {
  beforeEach(() => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: true, origin: 'https://spmticket.com.br' })
  })

  it('500s when the HMAC secret is missing', async () => {
    mocks.registerUazapiWebhook.mockResolvedValue({ ok: false, reason: 'webhook_secret_missing' })
    const res = await POST(postRequest())
    expect(res.status).toBe(500)
  })

  it('502s on an external UAZAPI failure', async () => {
    mocks.registerUazapiWebhook.mockResolvedValue({
      ok: false,
      reason: 'external_error',
      externalStatus: 401,
      externalCode: 'unauthorized',
    })
    const res = await POST(postRequest())
    expect(res.status).toBe(502)
  })
})

describe('POST /api/uazapi/webhook/register — response never leaks secrets', () => {
  it('success response is exactly {success:true} — no token/HMAC/URL', async () => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: true, origin: 'https://spmticket.com.br' })
    const res = await POST(postRequest())
    const json = await res.json()
    expect(Object.keys(json)).toEqual(['success'])
  })

  it('failure response only ever has an "error" key', async () => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: false, reason: 'unset' })
    const res = await POST(postRequest({}))
    const json = await res.json()
    expect(Object.keys(json)).toEqual(['error'])
  })
})

describe('POST /api/uazapi/webhook/register — account isolation', () => {
  beforeEach(() => {
    mocks.resolveConfiguredSiteOrigin.mockReturnValue({ ok: true, origin: 'https://spmticket.com.br' })
  })

  it('account A only ever registers instance A, account B only ever registers instance B', async () => {
    mocks.requireRole.mockResolvedValueOnce(CTX_A)
    mocks.loadActiveWhatsAppConfig.mockResolvedValueOnce(CONFIG_A)
    await POST(postRequest())
    expect(mocks.registerUazapiWebhook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ instanceToken: 'token-A', instanceId: 'inst-A' }),
    )

    mocks.requireRole.mockResolvedValueOnce(CTX_B)
    mocks.loadActiveWhatsAppConfig.mockResolvedValueOnce(CONFIG_B)
    await POST(postRequest())
    expect(mocks.registerUazapiWebhook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ instanceToken: 'token-B', instanceId: 'inst-B' }),
    )
  })
})
