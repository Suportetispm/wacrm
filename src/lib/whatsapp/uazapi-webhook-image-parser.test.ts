import { describe, expect, it } from 'vitest'
import { parseInboundImageMessage } from './uazapi-webhook-image-parser'

const TWENTY_MB = 20 * 1024 * 1024

// Real-shaped fixture, matching the FASE 4A TEMP_IMAGE_SHAPE_DISCOVERY
// capture: contentKeys = URL, mimetype, fileSHA256, fileLength, height,
// width, mediaKey, fileEncSHA256, directPath, mediaKeyTimestamp,
// contextInfo, viewOnce — no fileName, no caption, no thumbnail field.
function realImagePayload(
  overrides: {
    message?: Record<string, unknown>
    content?: Record<string, unknown>
    chat?: Record<string, unknown>
    EventType?: unknown
  } = {},
) {
  const content = {
    URL: 'https://example.uazapi.test/media/secret-image',
    mimetype: 'image/jpeg',
    fileSHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileLength: 44_749,
    height: 720,
    width: 1280,
    mediaKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    fileEncSHA256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    directPath: '/v/t62.7118-24/secret-path',
    mediaKeyTimestamp: 1735686000,
    contextInfo: {},
    viewOnce: false,
    ...overrides.content,
  }

  const message = {
    chatid: '5591999999999@s.whatsapp.net',
    content,
    fromMe: false,
    id: '5591AAAA000011112222333344445555AAAA',
    isGroup: false,
    messageTimestamp: 1735686000000,
    messageType: 'ImageMessage',
    messageid: '5591BBBB000011112222333344445555BBBB',
    sender: '5591888888888@s.whatsapp.net',
    senderName: 'Cliente Teste',
    sender_pn: '5591888888888',
    status: 'delivered',
    text: '',
    type: 'media',
    wasSentByApi: false,
    ...overrides.message,
  }

  return {
    EventType: overrides.EventType ?? 'messages',
    chat: { wa_isGroup: false, ...overrides.chat },
    chatSource: 'whatsapp',
    message,
    instanceName: 'instance-secret-name',
    owner: 'owner-secret',
    BaseUrl: 'https://server.example.test',
    token: 'super-secret-instance-token',
  }
}

describe('parseInboundImageMessage — accepts a valid image', () => {
  it('parses a real-shaped ImageMessage payload (JPEG)', () => {
    const parsed = parseInboundImageMessage(realImagePayload())
    expect(parsed).toEqual({
      providerMessageId: '5591BBBB000011112222333344445555BBBB',
      providerDownloadId: '5591AAAA000011112222333344445555AAAA',
      chatId: '5591999999999@s.whatsapp.net',
      sender: '5591888888888@s.whatsapp.net',
      senderName: 'Cliente Teste',
      occurredAt: new Date(1735686000000).toISOString(),
      mimeType: 'image/jpeg',
      fileSize: 44_749,
      width: 1280,
      height: 720,
      caption: undefined,
      fileName: 'image.jpg',
    })
  })

  it('accepts PNG and WebP, generating the matching fallback file name', () => {
    const png = parseInboundImageMessage(realImagePayload({ content: { mimetype: 'image/png' } }))
    expect(png?.mimeType).toBe('image/png')
    expect(png?.fileName).toBe('image.png')

    const webp = parseInboundImageMessage(realImagePayload({ content: { mimetype: 'image/webp' } }))
    expect(webp?.mimeType).toBe('image/webp')
    expect(webp?.fileName).toBe('image.webp')
  })

  it('captures a non-empty caption from message.text, sanitized (same convention as the document parser)', () => {
    const parsed = parseInboundImageMessage(realImagePayload({ message: { text: '  olha essa foto  ' } }))
    expect(parsed?.caption).toBe('olha essa foto')
  })

  it('omits senderName/width/height/caption when absent or malformed', () => {
    const parsed = parseInboundImageMessage(
      realImagePayload({
        message: { senderName: '', text: '' },
        content: { width: undefined, height: undefined },
      }),
    )
    expect(parsed?.senderName).toBeUndefined()
    expect(parsed?.width).toBeUndefined()
    expect(parsed?.height).toBeUndefined()
    expect(parsed?.caption).toBeUndefined()
  })

  it('never reads or returns URL, mediaKey, or hash/path fields', () => {
    const parsed = parseInboundImageMessage(realImagePayload()) as unknown as Record<string, unknown>
    for (const forbidden of ['URL', 'mediaKey', 'fileSHA256', 'fileEncSHA256', 'directPath', 'contextInfo']) {
      expect(parsed).not.toHaveProperty(forbidden)
    }
  })
})

describe('parseInboundImageMessage — privacy: view-once is never persisted', () => {
  it('rejects content.viewOnce === true unconditionally', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { viewOnce: true } }))).toBeNull()
  })

  it('accepts an otherwise-identical payload with viewOnce === false', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { viewOnce: false } }))).not.toBeNull()
  })
})

describe('parseInboundImageMessage — rejects out-of-scope events', () => {
  it('rejects a non-"messages" EventType', () => {
    expect(parseInboundImageMessage(realImagePayload({ EventType: 'connection' }))).toBeNull()
  })

  it('rejects group messages (message.isGroup)', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { isGroup: true } }))).toBeNull()
  })

  it('rejects group messages (chat.wa_isGroup defense-in-depth)', () => {
    expect(parseInboundImageMessage(realImagePayload({ chat: { wa_isGroup: true } }))).toBeNull()
  })

  it('rejects fromMe messages', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { fromMe: true } }))).toBeNull()
  })

  it('rejects API-echoed sends (wasSentByApi)', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { wasSentByApi: true } }))).toBeNull()
  })

  it('rejects a non-ImageMessage messageType', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { messageType: 'DocumentMessage' } }))).toBeNull()
  })

  it('rejects a non-"media" type', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { type: 'text' } }))).toBeNull()
  })
})

describe('parseInboundImageMessage — rejects invalid content', () => {
  it('rejects an unsupported mimetype', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { mimetype: 'image/gif' } }))).toBeNull()
    expect(parseInboundImageMessage(realImagePayload({ content: { mimetype: 'application/pdf' } }))).toBeNull()
  })

  it('rejects missing mimetype', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { mimetype: undefined } }))).toBeNull()
  })

  it('rejects zero/negative fileLength', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: 0 } }))).toBeNull()
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: -100 } }))).toBeNull()
  })

  it('rejects fileLength above the 20 MB decoded ceiling', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: TWENTY_MB + 1 } }))).toBeNull()
  })

  it('accepts fileLength exactly at the 20 MB ceiling and at 1 byte', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: TWENTY_MB } }))).not.toBeNull()
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: 1 } }))).not.toBeNull()
  })

  it('rejects a non-numeric fileLength', () => {
    expect(parseInboundImageMessage(realImagePayload({ content: { fileLength: '44749' } }))).toBeNull()
  })

  it('treats a non-positive or absurdly large width/height as absent rather than rejecting the image', () => {
    const negative = parseInboundImageMessage(realImagePayload({ content: { width: -10 } }))
    expect(negative?.width).toBeUndefined()
    expect(negative).not.toBeNull()

    const huge = parseInboundImageMessage(realImagePayload({ content: { height: 50_000 } }))
    expect(huge?.height).toBeUndefined()
    expect(huge).not.toBeNull()
  })
})

describe('parseInboundImageMessage — rejects missing ids', () => {
  it('rejects a missing/empty message.id (no providerDownloadId possible)', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { id: '' } }))).toBeNull()
  })

  it('rejects when both message.messageid and message.id are empty (no dedup id possible)', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { id: '', messageid: '' } }))).toBeNull()
  })

  it('rejects a missing chatId', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { chatid: '' } }))).toBeNull()
  })

  it('rejects a missing sender', () => {
    expect(parseInboundImageMessage(realImagePayload({ message: { sender: '' } }))).toBeNull()
  })
})

describe('parseInboundImageMessage — path traversal / injection-shaped ids never reach the caller unexamined', () => {
  it('passes a path-traversal-shaped id straight through as an opaque string (persistence layer is responsible for never using it as a path)', () => {
    const parsed = parseInboundImageMessage(
      realImagePayload({ message: { id: '../../etc/passwd', messageid: '../../etc/passwd' } }),
    )
    // The parser itself does no path construction — it only extracts
    // and returns the string. This pins that expectation so a future
    // change can't silently start trusting it as a filesystem path.
    expect(parsed?.providerDownloadId).toBe('../../etc/passwd')
    expect(parsed?.providerMessageId).toBe('../../etc/passwd')
  })
})
