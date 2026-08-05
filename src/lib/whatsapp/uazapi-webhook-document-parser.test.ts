import { describe, expect, it } from 'vitest'
import { parseInboundDocumentMessage } from './uazapi-webhook-document-parser'

const TWENTY_MB = 20 * 1024 * 1024

function realDocumentPayload(overrides: {
  message?: Record<string, unknown>
  content?: Record<string, unknown>
  chat?: Record<string, unknown>
  EventType?: unknown
} = {}) {
  const content = {
    URL: 'https://example.uazapi.test/media/secret',
    mimetype: 'application/pdf',
    fileSHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileLength: 3_671_331,
    pageCount: 4,
    mediaKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    fileName: 'invoice.pdf',
    fileEncSHA256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    directPath: '/v/t62.7161-24/secret-path',
    mediaKeyTimestamp: 1735686000,
    thumbnailDirectPath: '/v/t62.7161-24/secret-thumb',
    thumbnailSHA256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    thumbnailEncSHA256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    JPEGThumbnail: 'ffffffffffffffffffffffffffffffff',
    contextInfo: {},
    thumbnailHeight: 200,
    thumbnailWidth: 150,
    ...overrides.content,
  }

  const message = {
    buttonOrListid: '',
    chatid: '5591999999999@s.whatsapp.net',
    chatlid: '',
    content,
    convertOptions: '',
    edited: '',
    fromMe: false,
    groupName: '',
    id: '5591AAAA000011112222333344445555AAAA',
    isGroup: false,
    mediaType: 'document',
    messageTimestamp: 1735686000000,
    messageType: 'DocumentMessage',
    messageid: '5591BBBB000011112222333344445555BBBB',
    owner: '5591000000000',
    pinned: false,
    quoted: '',
    reaction: '',
    sender: '5591888888888@s.whatsapp.net',
    senderName: 'Cliente Teste',
    sender_lid: '',
    sender_pn: '5591888888888',
    source: 'android',
    status: 'delivered',
    text: '',
    track_id: '',
    track_source: '',
    type: 'media',
    vote: '',
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

describe('parseInboundDocumentMessage — accepts a valid PDF', () => {
  it('parses a real-shaped DocumentMessage payload', () => {
    const parsed = parseInboundDocumentMessage(realDocumentPayload())
    expect(parsed).toEqual({
      providerMessageId: '5591BBBB000011112222333344445555BBBB',
      providerDownloadId: '5591AAAA000011112222333344445555AAAA',
      chatId: '5591999999999@s.whatsapp.net',
      sender: '5591888888888@s.whatsapp.net',
      senderName: 'Cliente Teste',
      occurredAt: new Date(1735686000000).toISOString(),
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fileSize: 3_671_331,
      pageCount: 4,
      caption: undefined,
    })
  })

  it('uses providerDownloadId (message.id) and providerMessageId (message.messageid) as DISTINCT values, never assumed equal', () => {
    const payload = realDocumentPayload({
      message: { id: 'download-id-value', messageid: 'dedup-id-value' },
    })
    const parsed = parseInboundDocumentMessage(payload)
    expect(parsed?.providerDownloadId).toBe('download-id-value')
    expect(parsed?.providerMessageId).toBe('dedup-id-value')
    expect(parsed?.providerDownloadId).not.toBe(parsed?.providerMessageId)
  })

  it('falls back to message.id for providerMessageId when messageid is empty (same rule as the text parser)', () => {
    const payload = realDocumentPayload({ message: { id: 'only-id-present', messageid: '' } })
    const parsed = parseInboundDocumentMessage(payload)
    expect(parsed?.providerMessageId).toBe('only-id-present')
    expect(parsed?.providerDownloadId).toBe('only-id-present')
  })

  it('captures a non-empty caption from message.text, sanitized', () => {
    const payload = realDocumentPayload({ message: { text: '  Segue o contrato  ' } })
    const parsed = parseInboundDocumentMessage(payload)
    expect(parsed?.caption).toBe('Segue o contrato')
  })

  it('omits senderName/pageCount/caption when absent', () => {
    const payload = realDocumentPayload({
      message: { senderName: '', text: '' },
      content: { pageCount: undefined },
    })
    const parsed = parseInboundDocumentMessage(payload)
    expect(parsed?.senderName).toBeUndefined()
    expect(parsed?.pageCount).toBeUndefined()
    expect(parsed?.caption).toBeUndefined()
  })
})

describe('parseInboundDocumentMessage — rejects out-of-scope events', () => {
  it('rejects a non-"messages" EventType', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ EventType: 'connection' }))).toBeNull()
  })

  it('rejects group messages (message.isGroup)', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { isGroup: true } }))).toBeNull()
  })

  it('rejects group messages (chat.wa_isGroup defense-in-depth)', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ chat: { wa_isGroup: true } }))).toBeNull()
  })

  it('rejects fromMe messages', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { fromMe: true } }))).toBeNull()
  })

  it('rejects API-echoed sends (wasSentByApi)', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { wasSentByApi: true } }))).toBeNull()
  })

  it('rejects a non-DocumentMessage messageType', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { messageType: 'ImageMessage' } }))).toBeNull()
  })

  it('rejects a non-"media" type', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { type: 'text' } }))).toBeNull()
  })
})

describe('parseInboundDocumentMessage — rejects invalid content', () => {
  it('rejects a non-PDF mimetype', () => {
    expect(
      parseInboundDocumentMessage(realDocumentPayload({ content: { mimetype: 'application/zip' } })),
    ).toBeNull()
  })

  it('rejects missing mimetype', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { mimetype: undefined } }))).toBeNull()
  })

  it('rejects zero/negative fileLength', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { fileLength: 0 } }))).toBeNull()
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { fileLength: -100 } }))).toBeNull()
  })

  it('rejects fileLength above the 20 MB decoded ceiling', () => {
    expect(
      parseInboundDocumentMessage(realDocumentPayload({ content: { fileLength: TWENTY_MB + 1 } })),
    ).toBeNull()
  })

  it('accepts fileLength exactly at the 20 MB ceiling', () => {
    expect(
      parseInboundDocumentMessage(realDocumentPayload({ content: { fileLength: TWENTY_MB } })),
    ).not.toBeNull()
  })

  it('rejects a non-numeric fileLength', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { fileLength: '3671331' } }))).toBeNull()
  })

  it('rejects a missing/empty fileName', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: '' } }))).toBeNull()
    expect(parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: undefined } }))).toBeNull()
  })
})

describe('parseInboundDocumentMessage — rejects missing ids', () => {
  it('rejects a missing/empty message.id (no providerDownloadId possible)', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { id: '' } }))).toBeNull()
  })

  it('rejects when both message.messageid and message.id are empty (no dedup id possible)', () => {
    expect(
      parseInboundDocumentMessage(realDocumentPayload({ message: { id: '', messageid: '' } })),
    ).toBeNull()
  })

  it('rejects a missing chatId', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { chatid: '' } }))).toBeNull()
  })

  it('rejects a missing sender', () => {
    expect(parseInboundDocumentMessage(realDocumentPayload({ message: { sender: '' } }))).toBeNull()
  })
})

describe('parseInboundDocumentMessage — file name sanitization', () => {
  it('strips control characters', () => {
    const parsed = parseInboundDocumentMessage(
      realDocumentPayload({ content: { fileName: 'inv\x00oice\x1F.pdf' } }),
    )
    expect(parsed?.fileName).toBe('invoice.pdf')
  })

  it('drops directory components, keeping only the final segment', () => {
    const parsed = parseInboundDocumentMessage(
      realDocumentPayload({ content: { fileName: '../../etc/passwd/invoice.pdf' } }),
    )
    expect(parsed?.fileName).toBe('invoice.pdf')
    expect(parsed?.fileName).not.toContain('/')
  })

  it('drops Windows-style path separators too', () => {
    const parsed = parseInboundDocumentMessage(
      realDocumentPayload({ content: { fileName: 'C:\\Users\\victim\\invoice.pdf' } }),
    )
    expect(parsed?.fileName).toBe('invoice.pdf')
    expect(parsed?.fileName).not.toContain('\\')
  })

  it.each([
    ['../../arquivo.pdf', 'arquivo.pdf'],
    ['C:\\arquivo.pdf', 'arquivo.pdf'],
    ['/tmp/arquivo.pdf', 'arquivo.pdf'],
  ])('sanitizes the exact path-traversal example %s', (raw, expected) => {
    const parsed = parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: raw } }))
    expect(parsed?.fileName).toBe(expected)
    expect(parsed?.fileName).not.toContain('/')
    expect(parsed?.fileName).not.toContain('\\')
    expect(parsed?.fileName).not.toContain('..')
  })

  it('caps length while keeping the .pdf extension', () => {
    const longName = `${'a'.repeat(500)}.pdf`
    const parsed = parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: longName } }))
    expect(parsed?.fileName.length).toBeLessThanOrEqual(150 + 4)
    expect(parsed?.fileName.toLowerCase().endsWith('.pdf')).toBe(true)
  })

  it('appends .pdf when the declared name has no extension', () => {
    const parsed = parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: 'invoice' } }))
    expect(parsed?.fileName).toBe('invoice.pdf')
  })

  it('falls back to a generic name if sanitization empties the string (trailing separator leaves an empty final segment)', () => {
    const parsed = parseInboundDocumentMessage(realDocumentPayload({ content: { fileName: 'a/b/' } }))
    expect(parsed?.fileName).toBe('document.pdf')
  })
})

describe('parseInboundDocumentMessage — never leaks sensitive fields', () => {
  it('the returned object contains no key from the sensitive-field list', () => {
    const parsed = parseInboundDocumentMessage(realDocumentPayload())
    expect(parsed).not.toBeNull()
    const serialized = JSON.stringify(parsed)
    for (const forbidden of [
      'URL',
      'mediaKey',
      'directPath',
      'fileSHA256',
      'fileEncSHA256',
      'thumbnailDirectPath',
      'thumbnailSHA256',
      'thumbnailEncSHA256',
      'JPEGThumbnail',
      'instanceName',
      'BaseUrl',
      'token',
    ]) {
      expect(Object.keys(parsed as object)).not.toContain(forbidden)
      // Also confirm none of the actual secret VALUES leaked into an
      // unrelated field (e.g. caption/fileName accidentally echoing one).
      expect(serialized).not.toContain('secret')
    }
  })
})
