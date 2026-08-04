import { beforeEach, describe, expect, it, vi } from 'vitest'

// No real database and no real HMAC computation anywhere in this file
// — every DB call and the webhook-auth check are mocked.

const mocks = vi.hoisted(() => ({
  verifyUazapiWebhookToken: vi.fn(),
  parseInboundTextMessage: vi.fn(),
  persistInboundTextMessage: vi.fn(),
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-auth', () => ({
  verifyUazapiWebhookToken: mocks.verifyUazapiWebhookToken,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-parser', () => ({
  parseInboundTextMessage: mocks.parseInboundTextMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-persist', () => ({
  persistInboundTextMessage: mocks.persistInboundTextMessage,
}))

const CONFIG_ROW = { id: 'cfg-1', account_id: 'acct-1', user_id: 'user-1' }

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table in test: ${table}`)
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => ({ data: CONFIG_ROW, error: null }))
      return b
    },
  }),
}))

import { POST } from './route'

const VALID_HMAC = 'a'.repeat(64)
const INSTANCE_ID = 'fixture-instance-id'
const params = { params: Promise.resolve({ instanceId: INSTANCE_ID, hmac: VALID_HMAC }) }

function request(body: unknown = { EventType: 'messages' }) {
  return new Request(`http://localhost/api/uazapi/webhook/${INSTANCE_ID}/${VALID_HMAC}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.verifyUazapiWebhookToken.mockReset()
  mocks.parseInboundTextMessage.mockReset()
  mocks.persistInboundTextMessage.mockReset()
  mocks.verifyUazapiWebhookToken.mockReturnValue(true)
})

describe('POST /api/uazapi/webhook/[instanceId]/[hmac]', () => {
  it('returns 200 {status: "ignored"} when the event is out of scope for the parser, without calling persistence', async () => {
    mocks.parseInboundTextMessage.mockReturnValue(null)

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
  })

  it('returns 200 {status: "persisted"} when persistence reports a new message', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({ outcome: 'persisted' })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'persisted' })
  })

  it('returns 200 {status: "duplicate"} when persistence reports a redelivery no-op', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({ outcome: 'duplicate' })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'duplicate' })
  })

  it('returns 503 {error: "persistence_failed"} on a real persistence failure, never 200', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({ outcome: 'error', code: 'database_failed' })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
  })

  it('rejects an invalid HMAC before ever touching the parser or persistence', async () => {
    mocks.verifyUazapiWebhookToken.mockReturnValue(false)

    const res = await POST(request(), params)

    expect(res.status).toBe(401)
    expect(mocks.parseInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
  })
})
