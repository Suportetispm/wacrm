import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadActiveWhatsAppConfig: vi.fn(),
  getWebhookConfiguration: vi.fn(),
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
    getWebhookConfiguration: mocks.getWebhookConfiguration,
  }
})

import { UazapiHttpError } from '@/lib/whatsapp/uazapi-api'
import { GET } from './route'

const CONFIG_A = { provider: 'uazapi' as const, instanceToken: 'token-A', configId: 'cfg-A' }

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.loadActiveWhatsAppConfig.mockReset()
  mocks.getWebhookConfiguration.mockReset()
  mocks.requireRole.mockResolvedValue({ supabase: {}, accountId: 'acct-A' })
  mocks.loadActiveWhatsAppConfig.mockResolvedValue(CONFIG_A)
})

describe('GET /api/uazapi/webhook/status', () => {
  it('400s uazapi_not_configured when there is no uazapi config', async () => {
    mocks.loadActiveWhatsAppConfig.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('uazapi_not_configured')
  })

  it('reflects an active, enabled webhook', async () => {
    mocks.getWebhookConfiguration.mockResolvedValue([
      { enabled: true, url: 'https://spmticket.com.br/api/uazapi/webhook/inst-A/hmac', events: ['messages'] },
    ])
    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ configured: true, enabled: true, events: ['messages'], hasUrl: true })
  })

  it('reflects a registered-but-disabled webhook', async () => {
    mocks.getWebhookConfiguration.mockResolvedValue([
      { enabled: false, url: 'https://spmticket.com.br/api/uazapi/webhook/inst-A/hmac', events: ['messages'] },
    ])
    const res = await GET()
    const json = await res.json()
    expect(json).toEqual({ configured: true, enabled: false, events: ['messages'], hasUrl: true })
  })

  it('reflects no webhook configured at all', async () => {
    mocks.getWebhookConfiguration.mockResolvedValue([])
    const res = await GET()
    const json = await res.json()
    expect(json).toEqual({ configured: false, enabled: null, events: [], hasUrl: false })
  })

  it('maps a 401/403/404 external error to 409 instance_invalid', async () => {
    mocks.getWebhookConfiguration.mockRejectedValue(new UazapiHttpError(404, 'not found'))
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe('instance_invalid')
  })

  it('maps any other external failure to a generic 502', async () => {
    mocks.getWebhookConfiguration.mockRejectedValue(new Error('network exploded'))
    const res = await GET()
    expect(res.status).toBe(502)
  })

  it('response never contains a URL, HMAC, token, or secret', async () => {
    mocks.getWebhookConfiguration.mockResolvedValue([
      { enabled: true, url: 'https://spmticket.com.br/api/uazapi/webhook/inst-A/deadbeef', events: ['messages'] },
    ])
    const res = await GET()
    const json = await res.json()
    expect(Object.keys(json).sort()).toEqual(['configured', 'enabled', 'events', 'hasUrl'])
    expect(JSON.stringify(json)).not.toContain('deadbeef')
    expect(JSON.stringify(json)).not.toContain('token-A')
  })
})
