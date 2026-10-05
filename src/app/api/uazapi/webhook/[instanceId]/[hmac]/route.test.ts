import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No real database, no real HMAC computation, no real decrypt, and no
// real download/upload/RPC anywhere in this file — every DB call, the
// webhook-auth check, and all three parser/persist pairs (text,
// document, image) are mocked.

const mocks = vi.hoisted(() => ({
  verifyUazapiWebhookToken: vi.fn(),
  parseInboundTextMessage: vi.fn(),
  persistInboundTextMessage: vi.fn(),
  parseInboundDocumentMessage: vi.fn(),
  persistInboundDocumentMessage: vi.fn(),
  parseInboundImageMessage: vi.fn(),
  persistInboundImageMessage: vi.fn(),
  // TEMPORARY — audio download discovery.
  shouldRunAudioDownloadDiscovery: vi.fn(() => false),
  runAudioDownloadDiscovery: vi.fn(async () => {}),
  decrypt: vi.fn(),
  isAccountActive: vi.fn(),
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false, outcome: 'no_match' as const })),
}))

// Mocked so the media-dispatch tests below can assert on call/no-call and
// args directly, instead of the real engine silently swallowing every
// call via the route's own defensive try/catch (its `isAccountActive`
// would otherwise hit `.from('accounts')`, which the admin-client mock
// below doesn't model and would throw on).
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: mocks.dispatchInboundToFlows,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-auth', () => ({
  verifyUazapiWebhookToken: mocks.verifyUazapiWebhookToken,
}))

vi.mock('@/lib/accounts/active', () => ({
  isAccountActive: mocks.isAccountActive,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-parser', () => ({
  parseInboundTextMessage: mocks.parseInboundTextMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-persist', () => ({
  persistInboundTextMessage: mocks.persistInboundTextMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-document-parser', () => ({
  parseInboundDocumentMessage: mocks.parseInboundDocumentMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-document-persist', () => ({
  persistInboundDocumentMessage: mocks.persistInboundDocumentMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-image-parser', () => ({
  parseInboundImageMessage: mocks.parseInboundImageMessage,
}))

vi.mock('@/lib/whatsapp/uazapi-webhook-image-persist', () => ({
  persistInboundImageMessage: mocks.persistInboundImageMessage,
}))

// TEMPORARY — audio download discovery (module unit-tested on its own).
vi.mock('@/lib/whatsapp/uazapi-audio-download-discovery', () => ({
  shouldRunAudioDownloadDiscovery: mocks.shouldRunAudioDownloadDiscovery,
  runAudioDownloadDiscovery: mocks.runAudioDownloadDiscovery,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mocks.decrypt,
}))

const CONFIG_ROW = { id: 'cfg-1', account_id: 'acct-1', user_id: 'user-1' }

// Fixture ciphertext only — never a real token, and `decrypt` is
// mocked above so its actual bytes are never parsed as GCM output.
let tokenLookupResult: { data: { uazapi_instance_token: string } | null; error: unknown } = {
  data: { uazapi_instance_token: 'fixture-ciphertext' },
  error: null,
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table in test: ${table}`)
      let selectedColumns = ''
      const b: Record<string, unknown> = {}
      b.select = vi.fn((cols: string) => {
        selectedColumns = cols
        return b
      })
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => {
        if (selectedColumns.includes('uazapi_instance_token')) return tokenLookupResult
        return { data: CONFIG_ROW, error: null }
      })
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

// Minimal, in-scope parsed-document fixture — the parser itself
// (field-level filtering: fromMe/wasSentByApi/group/mimetype/etc.) is
// unit-tested independently in uazapi-webhook-document-parser.test.ts.
// This route suite only exercises how the route maps an already-parsed
// document to a response, mirroring how the text path is tested here.
const PARSED_DOCUMENT_FIXTURE = {
  providerMessageId: 'doc-msg-1',
  providerDownloadId: 'doc-dl-1',
  chatId: '551199999999@s.whatsapp.net',
  sender: '551199999999@s.whatsapp.net',
  senderName: 'Fixture',
  occurredAt: '2026-01-01T00:00:00.000Z',
  fileName: 'document.pdf',
  mimeType: 'application/pdf',
  fileSize: 1024,
}

// Same rationale as PARSED_DOCUMENT_FIXTURE — image parser field-level
// filtering (fromMe/wasSentByApi/group/viewOnce/mimetype/etc.) is
// unit-tested independently in uazapi-webhook-image-parser.test.ts.
const PARSED_IMAGE_FIXTURE = {
  providerMessageId: 'img-msg-1',
  providerDownloadId: 'img-dl-1',
  chatId: '551199999999@s.whatsapp.net',
  sender: '551199999999@s.whatsapp.net',
  senderName: 'Fixture',
  occurredAt: '2026-01-01T00:00:00.000Z',
  mimeType: 'image/jpeg',
  fileSize: 1024,
  width: 800,
  height: 600,
  fileName: 'image.jpg',
}

beforeEach(() => {
  mocks.verifyUazapiWebhookToken.mockReset()
  mocks.parseInboundTextMessage.mockReset()
  mocks.persistInboundTextMessage.mockReset()
  mocks.parseInboundDocumentMessage.mockReset()
  mocks.persistInboundDocumentMessage.mockReset()
  mocks.parseInboundImageMessage.mockReset()
  mocks.persistInboundImageMessage.mockReset()
  mocks.decrypt.mockReset()
  mocks.verifyUazapiWebhookToken.mockReturnValue(true)
  mocks.parseInboundDocumentMessage.mockReturnValue(null)
  mocks.parseInboundImageMessage.mockReturnValue(null)
  // TEMPORARY — audio download discovery: off by default in every test.
  mocks.shouldRunAudioDownloadDiscovery.mockReset()
  mocks.shouldRunAudioDownloadDiscovery.mockReturnValue(false)
  mocks.runAudioDownloadDiscovery.mockReset()
  mocks.runAudioDownloadDiscovery.mockResolvedValue(undefined)
  mocks.decrypt.mockReturnValue('fixture-decrypted-token')
  mocks.isAccountActive.mockReset()
  mocks.isAccountActive.mockResolvedValue(true)
  mocks.dispatchInboundToFlows.mockClear()
  mocks.dispatchInboundToFlows.mockResolvedValue({ consumed: false, outcome: 'no_match' })
  tokenLookupResult = { data: { uazapi_instance_token: 'fixture-ciphertext' }, error: null }
})

describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — text path (unchanged)', () => {
  it('returns 200 {status: "ignored"} when out of scope for both parsers, without calling either persistence path', async () => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
    // Default from beforeEach already returns null; set explicitly so
    // this test still documents the contract if the default changes.
    mocks.parseInboundDocumentMessage.mockReturnValue(null)

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.parseInboundDocumentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
  })

  it('logs a distinct, safe diagnostic when the event is ignored specifically because only a LID (no phone) could be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(null)
    mocks.parseInboundImageMessage.mockReturnValue(null)

    const res = await POST(
      request({
        EventType: 'messages',
        message: { sender: '208756952567854@lid', chatid: '208756952567854@lid' },
      }),
      params,
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(warnSpy).toHaveBeenCalledWith(
      '[uazapi/webhook:capture] inbound skipped: canonical phone could not be resolved',
      expect.objectContaining({ lid_detected: true }),
    )
    // Never leaks the LID's own digits into the log.
    const serialized = JSON.stringify(warnSpy.mock.calls)
    expect(serialized).not.toContain('208756952567854')

    warnSpy.mockRestore()
  })

  it('does NOT log the LID diagnostic for an unrelated ignore reason (no message field at all)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(null)

    await POST(request(), params)

    expect(warnSpy).not.toHaveBeenCalledWith(
      '[uazapi/webhook:capture] inbound skipped: canonical phone could not be resolved',
      expect.anything(),
    )
    warnSpy.mockRestore()
  })

  it('covers audio/video/stickers and other unsupported media: still ignored when text, document, AND image parsers all reject it', async () => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(null)
    mocks.parseInboundImageMessage.mockReturnValue(null)

    const res = await POST(
      request({ EventType: 'messages', message: { messageType: 'AudioMessage', type: 'media' } }),
      params,
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })

  it('returns 200 {status: "persisted"} when persistence reports a new message, and never touches the document path', async () => {
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
    expect(mocks.parseInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
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
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
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

  it('rejects an invalid HMAC before ever touching either parser or either persistence path', async () => {
    mocks.verifyUazapiWebhookToken.mockReturnValue(false)

    const res = await POST(request(), params)

    expect(res.status).toBe(401)
    expect(mocks.parseInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.parseInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.parseInboundImageMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })
})

describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — document (PDF) path', () => {
  function documentRequest() {
    return request({ EventType: 'messages', message: { messageType: 'DocumentMessage', type: 'media' } })
  }

  beforeEach(() => {
    // Every test in this block starts from "not a text message" so the
    // route falls through to the document parser, exactly as it would
    // for a real inbound PDF.
    mocks.parseInboundTextMessage.mockReturnValue(null)
  })

  it('calls parseInboundDocumentMessage only after the text parser rejects the event', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'persisted' })

    await POST(documentRequest(), params)

    expect(mocks.parseInboundTextMessage).toHaveBeenCalledTimes(1)
    expect(mocks.parseInboundDocumentMessage).toHaveBeenCalledTimes(1)
  })

  it('calls persistInboundDocumentMessage with a decrypted instance token and returns 200 {status:"persisted", type:"document"}', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'persisted' })

    const res = await POST(documentRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'persisted', type: 'document' })
    expect(mocks.persistInboundDocumentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.persistInboundDocumentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: CONFIG_ROW.account_id,
        configOwnerUserId: CONFIG_ROW.user_id,
        instanceToken: 'fixture-decrypted-token',
        parsed: PARSED_DOCUMENT_FIXTURE,
      }),
    )
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
  })

  it('returns 200 {status:"duplicate", type:"document"} when document persistence reports a redelivery no-op', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'duplicate' })

    const res = await POST(documentRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'duplicate', type: 'document' })
  })

  it('returns 503 {error:"persistence_failed"} on a real document persistence failure, never 200', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'error', code: 'upload_failed' })

    const res = await POST(documentRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
  })

  it('returns 503 {error:"persistence_failed"} when the instance token row is missing, without calling persistInboundDocumentMessage', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    tokenLookupResult = { data: null, error: null }

    const res = await POST(documentRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
  })

  it('returns 503 {error:"persistence_failed"} when the token lookup itself errors, without calling persistInboundDocumentMessage', async () => {
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    tokenLookupResult = { data: null, error: { message: 'db unreachable' } }

    const res = await POST(documentRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
  })

  it('never logs the decrypted token, file name, sender, provider ids, or any secret-shaped value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const secretShapedFixture = {
      ...PARSED_DOCUMENT_FIXTURE,
      providerMessageId: 'DOC-MESSAGE-ID-MARKER',
      providerDownloadId: 'DOC-DOWNLOAD-ID-MARKER',
      fileName: 'super-secret-filename.pdf',
      sender: '5511988887777@s.whatsapp.net',
    }
    mocks.parseInboundDocumentMessage.mockReturnValue(secretShapedFixture)
    mocks.decrypt.mockReturnValue('DECRYPTED-TOKEN-MARKER')

    // Exercise persisted, duplicate, and error outcomes — every branch
    // that logs anything in the document path.
    mocks.persistInboundDocumentMessage.mockResolvedValueOnce({ outcome: 'persisted' })
    await POST(documentRequest(), params)
    mocks.persistInboundDocumentMessage.mockResolvedValueOnce({ outcome: 'duplicate' })
    await POST(documentRequest(), params)
    mocks.persistInboundDocumentMessage.mockResolvedValueOnce({ outcome: 'error', code: 'upload_failed' })
    await POST(documentRequest(), params)

    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
    const serialized = JSON.stringify(allLoggedArgs)

    for (const forbidden of [
      'DECRYPTED-TOKEN-MARKER',
      'fixture-ciphertext',
      'DOC-MESSAGE-ID-MARKER',
      'DOC-DOWNLOAD-ID-MARKER',
      'super-secret-filename',
      '5511988887777',
      VALID_HMAC,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    logSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// FASE 4B/4C — image (JPEG/PNG/WebP) path. TEMP_IMAGE_SHAPE_DISCOVERY
// (FASE 4A) has been fully removed now that the real parser/persist
// pair is wired in and tested — see docs/uazapi-webhook-progress.md.
describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — image path', () => {
  function imageRequest(message: Record<string, unknown> = { messageType: 'ImageMessage', type: 'media' }) {
    return request({ EventType: 'messages', message })
  }

  beforeEach(() => {
    // Every test in this block starts from "not a text message, not a
    // document" so the route falls through to the image parser, exactly
    // as it would for a real inbound image.
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(null)
  })

  it('calls parseInboundImageMessage only after the text and document parsers reject the event', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'persisted' })

    await POST(imageRequest(), params)

    expect(mocks.parseInboundTextMessage).toHaveBeenCalledTimes(1)
    expect(mocks.parseInboundDocumentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.parseInboundImageMessage).toHaveBeenCalledTimes(1)
  })

  it('calls persistInboundImageMessage with a decrypted instance token and returns 200 {status:"persisted", type:"image"}', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'persisted' })

    const res = await POST(imageRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'persisted', type: 'image' })
    expect(mocks.persistInboundImageMessage).toHaveBeenCalledTimes(1)
    expect(mocks.persistInboundImageMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: CONFIG_ROW.account_id,
        configOwnerUserId: CONFIG_ROW.user_id,
        instanceToken: 'fixture-decrypted-token',
        parsed: PARSED_IMAGE_FIXTURE,
      }),
    )
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
  })

  it('returns 200 {status:"duplicate", type:"image"} when image persistence reports a redelivery no-op', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'duplicate' })

    const res = await POST(imageRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'duplicate', type: 'image' })
  })

  it('returns 200 {status:"ignored"} for a view-once image — the parser rejects it, so persistence is never called', async () => {
    // The privacy decision (never persist viewOnce media) lives in
    // parseInboundImageMessage itself (unit-tested in
    // uazapi-webhook-image-parser.test.ts: "rejects content.viewOnce
    // === true unconditionally"). At the route level, a view-once
    // image is indistinguishable from any other out-of-scope event —
    // the mocked parser simply returns null, exactly as a real one
    // would for this payload.
    mocks.parseInboundImageMessage.mockReturnValue(null)

    const res = await POST(
      imageRequest({ messageType: 'ImageMessage', type: 'media', content: { viewOnce: true } }),
      params,
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })

  it('returns 200 {status:"ignored"} for an unsupported image MIME type', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(null)

    const res = await POST(
      imageRequest({ messageType: 'ImageMessage', type: 'media', content: { mimetype: 'image/gif' } }),
      params,
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })

  it('returns 503 {error:"persistence_failed"} on a real image persistence failure, never 200', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'error', code: 'upload_failed' })

    const res = await POST(imageRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
  })

  it('returns 503 {error:"persistence_failed"} when the instance token row is missing, without calling persistInboundImageMessage', async () => {
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    tokenLookupResult = { data: null, error: null }

    const res = await POST(imageRequest(), params)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json).toEqual({ error: 'persistence_failed' })
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })

  it('never logs the decrypted token, sender, provider ids, or any secret-shaped value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const secretShapedFixture = {
      ...PARSED_IMAGE_FIXTURE,
      providerMessageId: 'IMG-MESSAGE-ID-MARKER',
      providerDownloadId: 'IMG-DOWNLOAD-ID-MARKER',
      sender: '5511988887777@s.whatsapp.net',
    }
    mocks.parseInboundImageMessage.mockReturnValue(secretShapedFixture)
    mocks.decrypt.mockReturnValue('DECRYPTED-TOKEN-MARKER')

    mocks.persistInboundImageMessage.mockResolvedValueOnce({ outcome: 'persisted' })
    await POST(imageRequest(), params)
    mocks.persistInboundImageMessage.mockResolvedValueOnce({ outcome: 'duplicate' })
    await POST(imageRequest(), params)
    mocks.persistInboundImageMessage.mockResolvedValueOnce({ outcome: 'error', code: 'upload_failed' })
    await POST(imageRequest(), params)

    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls]
    const serialized = JSON.stringify(allLoggedArgs)

    for (const forbidden of [
      'DECRYPTED-TOKEN-MARKER',
      'fixture-ciphertext',
      'IMG-MESSAGE-ID-MARKER',
      'IMG-DOWNLOAD-ID-MARKER',
      '5511988887777',
      VALID_HMAC,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

// Media (image/document) as a Flow trigger for "nova entrada de
// atendimento" — see engine.ts's `dispatchInboundToFlows` active-run
// guard and `findEntryFlow`'s kind gating for the engine-side half of
// this. This block covers the route-side half: dispatch is called only
// for a genuinely new ('persisted', never 'duplicate') message, and only
// when the post-RPC routingState was actually confirmed — never on
// `routingState: null`, which means "unknown", not "unrouted".
describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — media as a Flow trigger', () => {
  const CONFIRMED_UNROUTED = { queueId: null, assignedAgentId: null }

  describe('document', () => {
    beforeEach(() => {
      mocks.parseInboundTextMessage.mockReturnValue(null)
    })
    function documentRequest() {
      return request({ EventType: 'messages', message: { messageType: 'DocumentMessage', type: 'media' } })
    }

    it('dispatches kind:"media", media_type:"document" with the confirmed post-RPC routing state', async () => {
      mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
      mocks.persistInboundDocumentMessage.mockResolvedValue({
        outcome: 'persisted',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        routingState: CONFIRMED_UNROUTED,
      })

      await POST(documentRequest(), params)

      expect(mocks.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
      expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith({
        accountId: CONFIG_ROW.account_id,
        userId: CONFIG_ROW.user_id,
        contactId: 'contact-1',
        conversationId: 'conv-1',
        queueId: null,
        assignedAgentId: null,
        message: {
          kind: 'media',
          media_type: 'document',
          meta_message_id: PARSED_DOCUMENT_FIXTURE.providerMessageId,
        },
        isFirstInboundMessage: false,
      })
    })

    it('does NOT dispatch when routingState is null (post-RPC re-read failed — fail-safe)', async () => {
      mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
      mocks.persistInboundDocumentMessage.mockResolvedValue({
        outcome: 'persisted',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        routingState: null,
      })

      const res = await POST(documentRequest(), params)

      expect(res.status).toBe(200) // message IS persisted — no retry storm
      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })

    it('does NOT dispatch on a duplicate (redelivery)', async () => {
      mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
      mocks.persistInboundDocumentMessage.mockResolvedValue({
        outcome: 'duplicate',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        routingState: CONFIRMED_UNROUTED,
      })

      await POST(documentRequest(), params)

      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })

    it('does NOT dispatch on a persistence error', async () => {
      mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
      mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'error', code: 'database_failed' })

      await POST(documentRequest(), params)

      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })
  })

  describe('image', () => {
    beforeEach(() => {
      mocks.parseInboundTextMessage.mockReturnValue(null)
      mocks.parseInboundDocumentMessage.mockReturnValue(null)
    })
    function imageRequest() {
      return request({ EventType: 'messages', message: { messageType: 'ImageMessage', type: 'media' } })
    }

    it('dispatches kind:"media", media_type:"image" with the confirmed post-RPC routing state', async () => {
      mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
      mocks.persistInboundImageMessage.mockResolvedValue({
        outcome: 'persisted',
        contactId: 'contact-2',
        conversationId: 'conv-2',
        routingState: CONFIRMED_UNROUTED,
      })

      await POST(imageRequest(), params)

      expect(mocks.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
      expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith({
        accountId: CONFIG_ROW.account_id,
        userId: CONFIG_ROW.user_id,
        contactId: 'contact-2',
        conversationId: 'conv-2',
        queueId: null,
        assignedAgentId: null,
        message: {
          kind: 'media',
          media_type: 'image',
          meta_message_id: PARSED_IMAGE_FIXTURE.providerMessageId,
        },
        isFirstInboundMessage: false,
      })
    })

    it('does NOT dispatch when routingState is null (post-RPC re-read failed — fail-safe)', async () => {
      mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
      mocks.persistInboundImageMessage.mockResolvedValue({
        outcome: 'persisted',
        contactId: 'contact-2',
        conversationId: 'conv-2',
        routingState: null,
      })

      const res = await POST(imageRequest(), params)

      expect(res.status).toBe(200)
      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })

    it('does NOT dispatch on a duplicate (redelivery)', async () => {
      mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
      mocks.persistInboundImageMessage.mockResolvedValue({
        outcome: 'duplicate',
        contactId: 'contact-2',
        conversationId: 'conv-2',
        routingState: CONFIRMED_UNROUTED,
      })

      await POST(imageRequest(), params)

      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })

    it('does NOT dispatch on a persistence error', async () => {
      mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
      mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'error', code: 'upload_failed' })

      await POST(imageRequest(), params)

      expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    })
  })
})

// Same routingState fail-safe gating as image/document above, now
// applied to the text path too (uazapi-webhook-persist.ts's post-RPC
// re-read). Pendency #2 from the previous implementation: the text
// path used to default a failed re-read to `{queueId:null,
// assignedAgentId:null}` instead of refusing to dispatch.
describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — text: routingState fail-safe gating', () => {
  function textRequest() {
    return request()
  }

  it('dispatches kind:"text" with the confirmed post-RPC routing state', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({
      outcome: 'persisted',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      routingState: { queueId: null, assignedAgentId: null },
      isFirstInboundMessage: true,
    })

    await POST(textRequest(), params)

    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith({
      accountId: CONFIG_ROW.account_id,
      userId: CONFIG_ROW.user_id,
      contactId: 'contact-1',
      conversationId: 'conv-1',
      queueId: null,
      assignedAgentId: null,
      message: { kind: 'text', text: 'hi', meta_message_id: 'ext-1' },
      isFirstInboundMessage: true,
    })
  })

  it('does NOT dispatch when routingState is null (post-RPC re-read failed — fail-safe)', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({
      outcome: 'persisted',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      routingState: null,
      isFirstInboundMessage: true,
    })

    const res = await POST(textRequest(), params)

    expect(res.status).toBe(200) // message IS persisted — no retry storm
    expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('does NOT dispatch on a duplicate (redelivery), even with a confirmed routingState', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({
      outcome: 'duplicate',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      routingState: { queueId: null, assignedAgentId: null },
      isFirstInboundMessage: true,
    })

    await POST(textRequest(), params)

    expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
  })
})

describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — accounts.is_active gate', () => {
  it('active account (default) still persists — regression guard', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-active',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({ outcome: 'persisted' })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(mocks.isAccountActive).toHaveBeenCalledWith(expect.anything(), CONFIG_ROW.account_id)
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'persisted' })
    expect(mocks.persistInboundTextMessage).toHaveBeenCalledTimes(1)
  })

  it('inactive account: 200 {status: "ignored"}, no parsing/persistence attempted at all', async () => {
    mocks.isAccountActive.mockResolvedValue(false)
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-inactive',
      phone: '551199999999',
      name: 'Fixture',
      text: 'should never be read',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'ignored' })
    expect(mocks.parseInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
  })

  it('inactive account: log line carries no phone/text/payload content', async () => {
    mocks.isAccountActive.mockResolvedValue(false)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await POST(
      request({
        EventType: 'messages',
        message: { text: 'SECRET-CONTENT-MARKER', sender: '5511977776666@s.whatsapp.net' },
      }),
      params,
    )

    const serialized = JSON.stringify(warnSpy.mock.calls)
    expect(serialized).not.toContain('SECRET-CONTENT-MARKER')
    expect(serialized).not.toContain('5511977776666')
    expect(serialized).not.toContain(CONFIG_ROW.account_id)

    warnSpy.mockRestore()
  })
})

describe('POST /api/uazapi/webhook — ETAPA 078B: connection comes from the resolved config, never the payload', () => {
  // A hostile/odd payload that tries to name its own connection — must be ignored.
  const HOSTILE_BODY = { EventType: 'messages', whatsapp_config_id: 'cfg-attacker', whatsappConfigId: 'cfg-attacker' }

  it('text: persistInboundTextMessage receives whatsappConfigId = config.id', async () => {
    mocks.parseInboundTextMessage.mockReturnValue({
      externalMessageId: 'ext-1',
      phone: '551199999999',
      name: 'Fixture',
      text: 'hi',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.persistInboundTextMessage.mockResolvedValue({ outcome: 'duplicate' })

    await POST(request(HOSTILE_BODY), params)

    expect(mocks.persistInboundTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: CONFIG_ROW.account_id, whatsappConfigId: CONFIG_ROW.id }),
    )
  })

  it('document: persistInboundDocumentMessage receives whatsappConfigId = config.id', async () => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(PARSED_DOCUMENT_FIXTURE)
    mocks.persistInboundDocumentMessage.mockResolvedValue({ outcome: 'duplicate' })

    await POST(request(HOSTILE_BODY), params)

    expect(mocks.persistInboundDocumentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: CONFIG_ROW.account_id, whatsappConfigId: CONFIG_ROW.id }),
    )
  })

  it('image: persistInboundImageMessage receives whatsappConfigId = config.id', async () => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
    mocks.parseInboundDocumentMessage.mockReturnValue(null)
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'duplicate' })

    await POST(request(HOSTILE_BODY), params)

    expect(mocks.persistInboundImageMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: CONFIG_ROW.account_id, whatsappConfigId: CONFIG_ROW.id }),
    )
  })
})

// TEMPORARY — audio shape discovery (UAZAPI_AUDIO_SHAPE_DISCOVERY=1).
// Remove together with `logIgnoredMediaShape` in route.ts.
describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — temporary audio shape discovery', () => {
  const PREFIX = '[uazapi/webhook:audio-shape]'

  const SENSITIVE_MARKERS = [
    'SECRET_TOKEN_SHOULD_NOT_APPEAR',
    'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
    'PRIVATE_BASEURL_SHOULD_NOT_APPEAR',
    'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
    'PRIVATE_NAME_SHOULD_NOT_APPEAR',
    'PRIVATE_JID_SHOULD_NOT_APPEAR',
    'PRIVATE_TEXT_SHOULD_NOT_APPEAR',
    'PRIVATE_URL_SHOULD_NOT_APPEAR',
    'PRIVATE_MEDIAKEY_SHOULD_NOT_APPEAR',
    'PRIVATE_DIRECTPATH_SHOULD_NOT_APPEAR',
    'PRIVATE_HASH_SHOULD_NOT_APPEAR',
    'PRIVATE_BASE64_SHOULD_NOT_APPEAR',
    'PRIVATE_MESSAGE_ID_SHOULD_NOT_APPEAR',
    'PRIVATE_MESSAGEID_SHOULD_NOT_APPEAR',
    'PRIVATE_KEYNAME_SHOULD_NOT_APPEAR',
    '5511987654321',
  ]

  /** Synthetic audio-like event: every value that must never be logged
   *  carries a unique marker. Field names follow the real image
   *  envelope (image-parser.ts) — the audio shape itself is unknown. */
  function audioPayload(overrides: { message?: Record<string, unknown>; content?: Record<string, unknown> } = {}) {
    return {
      EventType: 'messages',
      token: 'SECRET_TOKEN_SHOULD_NOT_APPEAR',
      owner: 'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
      BaseUrl: 'https://PRIVATE_BASEURL_SHOULD_NOT_APPEAR.example',
      instanceName: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
      chatSource: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
      chat: {
        phone: 'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
        name: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
        wa_chatid: 'PRIVATE_JID_SHOULD_NOT_APPEAR@s.whatsapp.net',
        wa_isGroup: false,
      },
      message: {
        id: 'PRIVATE_MESSAGE_ID_SHOULD_NOT_APPEAR',
        messageid: 'PRIVATE_MESSAGEID_SHOULD_NOT_APPEAR',
        chatid: 'PRIVATE_JID_SHOULD_NOT_APPEAR@s.whatsapp.net',
        sender: '5511987654321@s.whatsapp.net',
        sender_pn: 'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
        senderName: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
        text: 'PRIVATE_TEXT_SHOULD_NOT_APPEAR',
        fromMe: false,
        isGroup: false,
        wasSentByApi: false,
        messageType: 'AudioMessage',
        type: 'media',
        messageTimestamp: 1735686000000,
        content: {
          URL: 'https://PRIVATE_URL_SHOULD_NOT_APPEAR.example/a',
          mimetype: 'audio/ogg; codecs=opus',
          fileSHA256: 'PRIVATE_HASH_SHOULD_NOT_APPEAR',
          fileEncSHA256: 'PRIVATE_HASH_SHOULD_NOT_APPEAR',
          mediaKey: 'PRIVATE_MEDIAKEY_SHOULD_NOT_APPEAR',
          directPath: '/v/PRIVATE_DIRECTPATH_SHOULD_NOT_APPEAR',
          base64: 'PRIVATE_BASE64_SHOULD_NOT_APPEAR',
          fileLength: 12345,
          seconds: 7,
          PTT: true,
          contextInfo: {
            'PRIVATE_KEYNAME_SHOULD_NOT_APPEAR@s.whatsapp.net': 'PRIVATE_JID_SHOULD_NOT_APPEAR',
            mentionedJID: ['PRIVATE_JID_SHOULD_NOT_APPEAR@s.whatsapp.net'],
          },
          ...overrides.content,
        },
        ...overrides.message,
      },
    }
  }

  let logSpy: ReturnType<typeof vi.spyOn>

  // Fresh route module per test — the one-capture-per-process flag is
  // module state, and route.ts can't export a reset helper (App Router
  // route files may only export HTTP handlers/config).
  async function freshPOST() {
    vi.resetModules()
    return (await import('./route')).POST
  }

  function shapeLogCalls() {
    return logSpy.mock.calls.filter((args: unknown[]) => args[0] === PREFIX)
  }

  function parsedShapeLog(callIndex = 0) {
    return JSON.parse(shapeLogCalls()[callIndex][1] as string)
  }

  beforeEach(() => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('1: variable unset (default) — no diagnostic, response unchanged', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '')
    const post = await freshPOST()

    const res = await post(request(audioPayload()), params)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(shapeLogCalls()).toHaveLength(0)
  })

  it('1b: any value other than exactly "1" keeps it off', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', 'true')
    const post = await freshPOST()

    await post(request(audioPayload()), params)

    expect(shapeLogCalls()).toHaveLength(0)
  })

  it('2: non-pertinent events (wrong EventType, or no media hint) — no diagnostic', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(request({ EventType: 'connection', message: { type: 'media' } }), params)
    await post(
      request({ EventType: 'messages', message: { messageType: 'ReactionMessage', type: 'reaction', content: {} } }),
      params,
    )

    expect(shapeLogCalls()).toHaveLength(0)
  })

  it('2b: text/document/image accepted by their parsers — never reach the diagnostic', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()
    mocks.parseInboundImageMessage.mockReturnValue(PARSED_IMAGE_FIXTURE)
    mocks.persistInboundImageMessage.mockResolvedValue({ outcome: 'duplicate' })

    const res = await post(request(audioPayload()), params)

    expect(await res.json()).toEqual({ status: 'duplicate', type: 'image' })
    expect(shapeLogCalls()).toHaveLength(0)
  })

  it('3 + 5: an ignored audio event is captured, with the allowlisted values', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    const res = await post(request(audioPayload()), params)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(shapeLogCalls()).toHaveLength(1)
    const log = parsedShapeLog()
    expect(log.match).toBe('audio_hint')
    expect(log.allowedValues).toEqual({
      messageType: 'AudioMessage',
      type: 'media',
      mimetype: 'audio/ogg; codecs=opus',
      PTT: true,
      seconds: 7,
    })
    // Structure: key names and value types only, of `message` and
    // `message.content`.
    expect(log.messageShape.messageType).toBe('string')
    expect(log.messageShape.content.mediaKey).toBe('string')
    expect(log.messageShape.content.fileLength).toBe('number')
    expect(log.messageShape.content.contextInfo['<redacted-key>']).toBe('string')
  })

  it('3c: the outer envelope is never part of the logged structure', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(request(audioPayload()), params)

    const log = parsedShapeLog()
    expect(Object.keys(log).sort()).toEqual(['allowedValues', 'instanceId', 'match', 'messageShape'])
    const serialized = JSON.stringify(log)
    for (const envelopeKey of ['token', 'owner', 'BaseUrl', 'chatSource', 'instanceName', 'EventType', 'wa_chatid', 'wa_isGroup']) {
      expect(serialized).not.toContain(`"${envelopeKey}"`)
    }
    expect(log.messageShape).not.toHaveProperty('chat')
  })

  it('3b: fallback — an unexpected media type name with no audio hint is still captured', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(
      request(audioPayload({ message: { messageType: 'SomethingNew' }, content: { mimetype: undefined } })),
      params,
    )

    expect(shapeLogCalls()).toHaveLength(1)
    expect(parsedShapeLog().match).toBe('media_fallback')
  })

  it('4: at most one capture per process', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(request(audioPayload()), params)
    await post(request(audioPayload()), params)
    await post(request(audioPayload({ message: { messageType: 'PttMessage' } })), params)

    expect(shapeLogCalls()).toHaveLength(1)
  })

  it('6: no sensitive value, instance id or HMAC appears in any diagnostic argument', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(request(audioPayload()), params)

    expect(shapeLogCalls()).toHaveLength(1)
    const serialized = shapeLogCalls()
      .flat()
      .map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    for (const marker of [...SENSITIVE_MARKERS, VALID_HMAC, INSTANCE_ID]) {
      expect(serialized).not.toContain(marker)
    }
  })

  it('6b: an allowlisted field carrying a non-enum value is rejected, not echoed', async () => {
    vi.stubEnv('UAZAPI_AUDIO_SHAPE_DISCOVERY', '1')
    const post = await freshPOST()

    await post(
      request(
        audioPayload({
          message: { type: 'media', mediaType: 'PRIVATE_NAME_SHOULD_NOT_APPEAR 5511987654321' },
          content: { mimetype: 'audio/PRIVATE URL https://x', seconds: 'PRIVATE_TEXT_SHOULD_NOT_APPEAR' },
        }),
      ),
      params,
    )

    const log = parsedShapeLog()
    expect(log.allowedValues.mediaType).toBe('<rejected>')
    expect(log.allowedValues.mimetype).toBe('<rejected>')
    expect(log.allowedValues.seconds).toBeUndefined()
    const serialized = JSON.stringify(log)
    for (const marker of SENSITIVE_MARKERS) expect(serialized).not.toContain(marker)
  })
})

// TEMPORARY — audio download discovery: route wiring only (the module's
// own behavior is tested in uazapi-audio-download-discovery.test.ts).
// Remove together with the route block and the module.
describe('POST /api/uazapi/webhook/[instanceId]/[hmac] — TEMPORARY audio download discovery wiring', () => {
  function voiceNoteRequest() {
    return request({ EventType: 'messages', message: { messageType: 'AudioMessage', type: 'media', mediaType: 'ptt' } })
  }

  beforeEach(() => {
    mocks.parseInboundTextMessage.mockReturnValue(null)
  })

  it('when the gate says run: runs discovery with the decrypted token + masked id, returns 200, and never persists or dispatches', async () => {
    mocks.shouldRunAudioDownloadDiscovery.mockReturnValue(true)

    const res = await POST(voiceNoteRequest(), params)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(mocks.runAudioDownloadDiscovery).toHaveBeenCalledTimes(1)
    expect(mocks.runAudioDownloadDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ instanceToken: 'fixture-decrypted-token', maskedInstanceId: 'fix…id' }),
    )
    // No persistence path and no Flow. The admin-client mock only models
    // `whatsapp_config` reads (any other table, rpc or storage would
    // throw) — so a 200 here also proves no other DB access happened.
    expect(mocks.persistInboundTextMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundDocumentMessage).not.toHaveBeenCalled()
    expect(mocks.persistInboundImageMessage).not.toHaveBeenCalled()
    expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('token unavailable: still 200 with only a fixed code, discovery not run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    tokenLookupResult = { data: null, error: null }
    mocks.shouldRunAudioDownloadDiscovery.mockReturnValue(true)

    const res = await POST(voiceNoteRequest(), params)

    expect(res.status).toBe(200)
    expect(mocks.runAudioDownloadDiscovery).not.toHaveBeenCalled()
    const line = logSpy.mock.calls.find((a) => a[0] === '[uazapi/audio-download-shape]')
    expect(line?.[1]).toBe(JSON.stringify({ code: 'token_unavailable' }))
    logSpy.mockRestore()
  })

  it('when the gate says no (default): unchanged — an audio event is still acked 200 {status: "ignored"} without discovery', async () => {
    const res = await POST(voiceNoteRequest(), params)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(mocks.runAudioDownloadDiscovery).not.toHaveBeenCalled()
  })
})
