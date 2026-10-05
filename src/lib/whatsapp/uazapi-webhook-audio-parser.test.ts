import { describe, expect, it } from 'vitest'
import { parseInboundAudioMessage } from './uazapi-webhook-audio-parser'

// Real-shaped fixture, matching the controlled capture of a real inbound
// voice note (structure only — every value here is synthetic):
// messageType AudioMessage, type media, mediaType ptt, content keys
// URL, directPath, fileLength, fileSHA256, fileEncSHA256, mediaKey,
// mediaKeyTimestamp, waveform, mimetype, seconds, PTT.
function realVoiceNotePayload(
  overrides: {
    message?: Record<string, unknown>
    content?: Record<string, unknown>
    chat?: Record<string, unknown>
    EventType?: unknown
  } = {},
) {
  const content = {
    URL: 'https://example.uazapi.test/media/secret-audio',
    directPath: '/v/t62.7117-24/secret-path',
    fileLength: 5_432,
    fileSHA256: 'a'.repeat(44),
    fileEncSHA256: 'b'.repeat(44),
    mediaKey: 'c'.repeat(44),
    mediaKeyTimestamp: 1735686000,
    waveform: 'd'.repeat(64),
    mimetype: 'audio/ogg; codecs=opus',
    seconds: 3,
    PTT: true,
    ...overrides.content,
  }
  return {
    EventType: overrides.EventType ?? 'messages',
    token: 'fixture-token',
    owner: '5591900000000',
    BaseUrl: 'https://example.uazapi.test',
    chat: { phone: '+55 91 99999-9999', wa_chatid: '5591999999999@s.whatsapp.net', wa_isGroup: false, ...overrides.chat },
    message: {
      id: 'dl-id-1',
      messageid: 'msg-id-1',
      chatid: '5591999999999@s.whatsapp.net',
      sender: '5591999999999@s.whatsapp.net',
      sender_pn: '5591999999999@s.whatsapp.net',
      senderName: 'Cliente Teste',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      messageType: 'AudioMessage',
      type: 'media',
      mediaType: 'ptt',
      messageTimestamp: 1735686000000,
      content,
      ...overrides.message,
    },
  }
}

describe('parseInboundAudioMessage — real voice-note shape', () => {
  it('accepts the confirmed real shape (AudioMessage / media / ptt / audio/ogg; codecs=opus / PTT=true)', () => {
    const parsed = parseInboundAudioMessage(realVoiceNotePayload())
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      isVoiceNote: true,
      durationSeconds: 3,
      sourceMimeType: 'audio/ogg',
      chatId: '5591999999999@s.whatsapp.net',
      sender: '5591999999999@s.whatsapp.net',
      senderName: 'Cliente Teste',
    })
  })

  it('uses the same ID precedence as the other parsers: dedup = messageid then id; download = id', () => {
    const parsed = parseInboundAudioMessage(realVoiceNotePayload())!
    expect(parsed.providerMessageId).toBe('msg-id-1')
    expect(parsed.providerDownloadId).toBe('dl-id-1')

    const noMessageid = parseInboundAudioMessage(realVoiceNotePayload({ message: { messageid: '' } }))!
    expect(noMessageid.providerMessageId).toBe('dl-id-1')
  })

  it('rejects when message.id (the download id) is missing', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ message: { id: undefined } }))).toBeNull()
  })

  it('never exposes URL / mediaKey / directPath / hashes / waveform in its return value', () => {
    const serialized = JSON.stringify(parseInboundAudioMessage(realVoiceNotePayload()))
    for (const secret of ['secret-audio', 'secret-path', 'a'.repeat(44), 'b'.repeat(44), 'c'.repeat(44), 'd'.repeat(64)]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('fixture-token')
  })

  it('accepts a non-PTT audio file (mediaType "audio", PTT false) as audio, flagged as not a voice note', () => {
    const parsed = parseInboundAudioMessage(
      realVoiceNotePayload({ message: { mediaType: 'audio' }, content: { PTT: false, mimetype: 'audio/mpeg' } }),
    )
    expect(parsed?.isVoiceNote).toBe(false)
    expect(parsed?.sourceMimeType).toBe('audio/mpeg')
  })

  it('accepts a numeric-string fileLength and an absent one (declared size is only a pre-check)', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { fileLength: '5432' } }))).not.toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { fileLength: undefined } }))).not.toBeNull()
  })
})

describe('parseInboundAudioMessage — out of scope', () => {
  it.each([
    ['fromMe', { message: { fromMe: true } }],
    ['wasSentByApi', { message: { wasSentByApi: true } }],
    ['group (message.isGroup)', { message: { isGroup: true } }],
    ['group (chat.wa_isGroup)', { chat: { wa_isGroup: true } }],
    ['fromMe absent (not explicitly false)', { message: { fromMe: undefined } }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseInboundAudioMessage(realVoiceNotePayload(overrides))).toBeNull()
  })

  it('rejects other message types and non-media events', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ message: { messageType: 'ImageMessage' } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ message: { type: 'text' } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ message: { mediaType: 'video' } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ EventType: 'connection' }))).toBeNull()
  })

  it('rejects a non-audio or malformed mimetype', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { mimetype: 'image/jpeg' } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { mimetype: 'audio' } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { mimetype: undefined } }))).toBeNull()
  })

  it('rejects view-once audio (privacy)', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { viewOnce: true } }))).toBeNull()
  })

  it('rejects a declared size of 0 or above the 20 MB ceiling', () => {
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { fileLength: 0 } }))).toBeNull()
    expect(parseInboundAudioMessage(realVoiceNotePayload({ content: { fileLength: 20 * 1024 * 1024 + 1 } }))).toBeNull()
  })

  it('drops an absurd duration instead of rejecting the whole message', () => {
    const parsed = parseInboundAudioMessage(realVoiceNotePayload({ content: { seconds: -5 } }))
    expect(parsed).not.toBeNull()
    expect(parsed?.durationSeconds).toBeUndefined()
  })

  it('rejects non-object payloads', () => {
    expect(parseInboundAudioMessage(null)).toBeNull()
    expect(parseInboundAudioMessage('messages')).toBeNull()
    expect(parseInboundAudioMessage([])).toBeNull()
  })
})
