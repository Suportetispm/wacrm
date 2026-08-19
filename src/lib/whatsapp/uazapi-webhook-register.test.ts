import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  computeUazapiWebhookToken: vi.fn(),
  configureWebhook: vi.fn(),
}))

vi.mock('./uazapi-webhook-auth', () => ({
  computeUazapiWebhookToken: mocks.computeUazapiWebhookToken,
}))

// UazapiHttpError is a real class (not a mock function) so `instanceof`
// checks inside the module under test keep working against errors
// thrown by this mock.
vi.mock('./uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-api')>()
  return {
    ...actual,
    configureWebhook: mocks.configureWebhook,
  }
})

import { UazapiHttpError } from './uazapi-api'
import {
  buildUazapiWebhookUrl,
  classifyExternalError,
  ensureUazapiWebhookRegistered,
  registerUazapiWebhook,
  resolveConfiguredSiteOrigin,
} from './uazapi-webhook-register'

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL

beforeEach(() => {
  mocks.computeUazapiWebhookToken.mockReset()
  mocks.configureWebhook.mockReset()
  if (ORIGINAL_SITE_URL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL
})

describe('resolveConfiguredSiteOrigin', () => {
  it('reports unset when NEXT_PUBLIC_SITE_URL is not configured (dev)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    expect(resolveConfiguredSiteOrigin()).toEqual({ ok: false, reason: 'unset' })
  })

  it('resolves the origin from a valid https URL, dropping any trailing slash/path', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://spmticket.com.br/'
    expect(resolveConfiguredSiteOrigin()).toEqual({ ok: true, origin: 'https://spmticket.com.br' })
  })

  it('rejects a non-https value as invalid (fail closed, not treated as unset)', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://spmticket.com.br'
    expect(resolveConfiguredSiteOrigin()).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects an unparseable value as invalid', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'not a url'
    expect(resolveConfiguredSiteOrigin()).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('buildUazapiWebhookUrl', () => {
  it('embeds the exact instanceId and the HMAC computed for it', () => {
    mocks.computeUazapiWebhookToken.mockImplementation((id: string) => `hmac-for-${id}`)
    const url = buildUazapiWebhookUrl('https://spmticket.com.br', 'instance-A')
    expect(url).toBe('https://spmticket.com.br/api/uazapi/webhook/instance-A/hmac-for-instance-A')
    expect(mocks.computeUazapiWebhookToken).toHaveBeenCalledWith('instance-A')
  })

  it('returns null when UAZAPI_WEBHOOK_SECRET is unset (computeUazapiWebhookToken returns null)', () => {
    mocks.computeUazapiWebhookToken.mockReturnValue(null)
    expect(buildUazapiWebhookUrl('https://spmticket.com.br', 'instance-A')).toBeNull()
  })
})

describe('classifyExternalError', () => {
  it('maps known keyword patterns to fixed codes', () => {
    expect(classifyExternalError('Missing token')).toBe('missing_token')
    expect(classifyExternalError('Invalid token supplied')).toBe('invalid_token')
    expect(classifyExternalError('Forbidden')).toBe('forbidden')
    expect(classifyExternalError('Unauthorized')).toBe('unauthorized')
    expect(classifyExternalError('invalid payload')).toBe('invalid_payload')
    expect(classifyExternalError('something else entirely')).toBe('unknown_external_error')
    expect(classifyExternalError(undefined)).toBe('unknown_external_error')
  })
})

describe('registerUazapiWebhook', () => {
  beforeEach(() => {
    mocks.computeUazapiWebhookToken.mockImplementation((id: string) => `hmac-for-${id}`)
  })

  it('sends the fixed payload (enabled:true via configureWebhook, events, excludeMessages) to the correct instance token', async () => {
    mocks.configureWebhook.mockResolvedValue(undefined)

    const result = await registerUazapiWebhook({
      instanceToken: 'token-A',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'instance-A',
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.configureWebhook).toHaveBeenCalledTimes(1)
    expect(mocks.configureWebhook).toHaveBeenCalledWith({
      instanceToken: 'token-A',
      url: 'https://spmticket.com.br/api/uazapi/webhook/instance-A/hmac-for-instance-A',
      events: ['messages'],
      excludeMessages: ['wasSentByApi'],
    })
  })

  it('is idempotent — calling twice with the same args succeeds both times, no dedup error', async () => {
    mocks.configureWebhook.mockResolvedValue(undefined)
    const args = { instanceToken: 'token-A', baseOrigin: 'https://spmticket.com.br', instanceId: 'instance-A' }

    const first = await registerUazapiWebhook(args)
    const second = await registerUazapiWebhook(args)

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(mocks.configureWebhook).toHaveBeenCalledTimes(2)
  })

  it('returns webhook_secret_missing without ever calling configureWebhook when the HMAC secret is unset', async () => {
    mocks.computeUazapiWebhookToken.mockReturnValue(null)

    const result = await registerUazapiWebhook({
      instanceToken: 'token-A',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'instance-A',
    })

    expect(result).toEqual({ ok: false, reason: 'webhook_secret_missing' })
    expect(mocks.configureWebhook).not.toHaveBeenCalled()
  })

  it('never throws on a UazapiHttpError — returns a classified, status-carrying failure instead', async () => {
    mocks.configureWebhook.mockRejectedValue(new UazapiHttpError(401, 'Unauthorized'))

    const result = await registerUazapiWebhook({
      instanceToken: 'token-A',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'instance-A',
    })

    expect(result).toEqual({
      ok: false,
      reason: 'external_error',
      externalStatus: 401,
      externalCode: 'unauthorized',
    })
  })

  it('never throws on a generic (non-UazapiHttpError) failure either', async () => {
    mocks.configureWebhook.mockRejectedValue(new Error('network exploded'))

    await expect(
      registerUazapiWebhook({
        instanceToken: 'token-A',
        baseOrigin: 'https://spmticket.com.br',
        instanceId: 'instance-A',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'external_error',
      externalStatus: undefined,
      externalCode: 'unknown_external_error',
    })
  })

  it('account isolation: two instances never share a token/URL across calls', async () => {
    mocks.configureWebhook.mockResolvedValue(undefined)

    await registerUazapiWebhook({
      instanceToken: 'token-A',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'instance-A',
    })
    await registerUazapiWebhook({
      instanceToken: 'token-B',
      baseOrigin: 'https://spmticket.com.br',
      instanceId: 'instance-B',
    })

    expect(mocks.configureWebhook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ instanceToken: 'token-A', url: expect.stringContaining('/instance-A/') }),
    )
    expect(mocks.configureWebhook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ instanceToken: 'token-B', url: expect.stringContaining('/instance-B/') }),
    )
  })
})

describe('ensureUazapiWebhookRegistered', () => {
  beforeEach(() => {
    mocks.computeUazapiWebhookToken.mockImplementation((id: string) => `hmac-for-${id}`)
  })

  it('no-op in dev (NEXT_PUBLIC_SITE_URL unset) — never calls configureWebhook', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL

    const result = await ensureUazapiWebhookRegistered({
      instanceId: 'instance-A',
      instanceToken: 'token-A',
    })

    expect(result).toEqual({ ok: false, reason: 'no_production_origin' })
    expect(mocks.configureWebhook).not.toHaveBeenCalled()
  })

  it('registers using the configured production domain, ignoring nothing client-supplied (there is no client input here)', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://spmticket.com.br'
    mocks.configureWebhook.mockResolvedValue(undefined)

    const result = await ensureUazapiWebhookRegistered({
      instanceId: 'instance-A',
      instanceToken: 'token-A',
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.configureWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceToken: 'token-A',
        url: 'https://spmticket.com.br/api/uazapi/webhook/instance-A/hmac-for-instance-A',
      }),
    )
  })

  it('never throws when the external call fails — returns a failure result instead', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://spmticket.com.br'
    mocks.configureWebhook.mockRejectedValue(new UazapiHttpError(502, 'bad gateway'))

    await expect(
      ensureUazapiWebhookRegistered({ instanceId: 'instance-A', instanceToken: 'token-A' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'external_error',
      externalStatus: 502,
      externalCode: 'unknown_external_error',
    })
  })

  it('idempotent — calling twice in a row (e.g. two status polls) succeeds both times', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://spmticket.com.br'
    mocks.configureWebhook.mockResolvedValue(undefined)

    const first = await ensureUazapiWebhookRegistered({ instanceId: 'instance-A', instanceToken: 'token-A' })
    const second = await ensureUazapiWebhookRegistered({ instanceId: 'instance-A', instanceToken: 'token-A' })

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(mocks.configureWebhook).toHaveBeenCalledTimes(2)
  })
})
