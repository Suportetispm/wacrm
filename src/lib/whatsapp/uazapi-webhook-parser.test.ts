import { describe, expect, it } from 'vitest'
import { parseInboundTextMessage } from './uazapi-webhook-parser'

// Fictional payloads only — shaped after the confirmed real envelope
// (etapa 8.2C/8.2D), no real phone numbers, names, or ids.
function validPayload(overrides: {
  message?: Record<string, unknown>
  chat?: Record<string, unknown>
} = {}) {
  return {
    EventType: 'messages',
    chat: {
      phone: '551199999999',
      name: 'Fixture Chat Name',
      lead_name: '',
      lead_fullName: '',
      wa_contactName: '',
      wa_chatid: '551199999999@s.whatsapp.net',
      wa_isGroup: false,
      ...overrides.chat,
    },
    chatSource: { some: 'field' },
    message: {
      messageid: 'MSG-FIXTURE-001',
      id: 'internal-fixture-001',
      chatid: '551199999999@s.whatsapp.net',
      sender: '551199999999@s.whatsapp.net',
      senderName: 'Fixture Sender',
      sender_pn: '551199999999',
      fromMe: false,
      messageType: 'text',
      messageTimestamp: Date.now(),
      status: 'Delivered',
      text: 'Olá, isto é uma mensagem de teste.',
      isGroup: false,
      wasSentByApi: false,
      content: 'Olá, isto é uma mensagem de teste.',
      ...overrides.message,
    },
    instanceName: 'fixture-instance',
    owner: 'fixture-owner',
    BaseUrl: 'https://fixture.example.com',
    token: 'fixture-token',
  }
}

describe('parseInboundTextMessage', () => {
  it('parses a valid inbound text message', () => {
    const result = parseInboundTextMessage(validPayload())
    expect(result).not.toBeNull()
    expect(result?.externalMessageId).toBe('MSG-FIXTURE-001')
    expect(result?.phone).toBe('551199999999')
    expect(result?.name).toBe('Fixture Sender')
    expect(result?.text).toBe('Olá, isto é uma mensagem de teste.')
    expect(() => new Date(result!.occurredAt).toISOString()).not.toThrow()
  })

  it('is deterministic on the same fixture (dedup relies on a stable id)', () => {
    const payload = validPayload()
    const first = parseInboundTextMessage(payload)
    const second = parseInboundTextMessage(payload)
    expect(first?.externalMessageId).toBe(second?.externalMessageId)
    expect(first?.externalMessageId).toBeTruthy()
  })

  it('falls back to message.id when messageid is missing', () => {
    const result = parseInboundTextMessage(
      validPayload({ message: { messageid: undefined } }),
    )
    expect(result?.externalMessageId).toBe('internal-fixture-001')
  })

  it('rejects fromMe: true', () => {
    expect(parseInboundTextMessage(validPayload({ message: { fromMe: true } }))).toBeNull()
  })

  it('rejects wasSentByApi: true', () => {
    expect(
      parseInboundTextMessage(validPayload({ message: { wasSentByApi: true } })),
    ).toBeNull()
  })

  it('rejects a group message (message.isGroup)', () => {
    expect(parseInboundTextMessage(validPayload({ message: { isGroup: true } }))).toBeNull()
  })

  it('rejects a group chat (chat.wa_isGroup, defense in depth)', () => {
    expect(
      parseInboundTextMessage(validPayload({ chat: { wa_isGroup: true } })),
    ).toBeNull()
  })

  it('rejects empty text', () => {
    expect(parseInboundTextMessage(validPayload({ message: { text: '' } }))).toBeNull()
    expect(parseInboundTextMessage(validPayload({ message: { text: '   ' } }))).toBeNull()
  })

  it('rejects a non-text message type', () => {
    expect(
      parseInboundTextMessage(validPayload({ message: { messageType: 'image' } })),
    ).toBeNull()
  })

  it('rejects invalid payload shapes', () => {
    expect(parseInboundTextMessage(null)).toBeNull()
    expect(parseInboundTextMessage(undefined)).toBeNull()
    expect(parseInboundTextMessage('not an object')).toBeNull()
    expect(parseInboundTextMessage([])).toBeNull()
    expect(parseInboundTextMessage({})).toBeNull()
    expect(parseInboundTextMessage({ EventType: 'status' })).toBeNull()
    expect(parseInboundTextMessage({ EventType: 'messages' })).toBeNull() // no message
    expect(parseInboundTextMessage({ EventType: 'messages', message: 'not-an-object' })).toBeNull()
  })

  it('strips a WhatsApp JID suffix from the phone', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: undefined, sender: '551188887777@s.whatsapp.net' },
      }),
    )
    expect(result?.phone).toBe('551188887777')
  })

  it('falls back through the phone priority chain to chat.phone', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: undefined, sender: undefined, chatid: undefined },
        chat: { phone: '551177776666', wa_chatid: undefined },
      }),
    )
    expect(result?.phone).toBe('551177776666')
  })

  it('rejects when no usable phone candidate exists', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: undefined, sender: undefined, chatid: undefined },
        chat: { phone: undefined, wa_chatid: undefined },
      }),
    )
    expect(result).toBeNull()
  })

  it('rejects an @lid sender/chatid when no real phone candidate exists anywhere (never fabricates a phone from the LID digits)', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: {
          sender_pn: undefined,
          sender: '208756952567854@lid',
          chatid: '208756952567854@lid',
        },
        chat: { phone: undefined, wa_chatid: undefined },
      }),
    )
    expect(result).toBeNull()
  })

  it('prefers sender_pn over an @lid sender', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: '551199999999', sender: '208756952567854@lid' },
      }),
    )
    expect(result?.phone).toBe('551199999999')
  })

  it('falls through an @lid sender to a later real-phone candidate (chat.phone)', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: undefined, sender: '208756952567854@lid', chatid: undefined },
        chat: { phone: '551177776666', wa_chatid: undefined },
      }),
    )
    expect(result?.phone).toBe('551177776666')
  })

  it('never treats an unrecognized JID suffix as a phone', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { sender_pn: undefined, sender: '551199999999@g.us', chatid: undefined },
        chat: { phone: undefined, wa_chatid: undefined },
      }),
    )
    expect(result).toBeNull()
  })

  it('falls back to the phone as name when no name candidate exists', () => {
    const result = parseInboundTextMessage(
      validPayload({
        message: { senderName: undefined },
        chat: { lead_fullName: undefined, lead_name: undefined, wa_contactName: undefined, name: undefined },
      }),
    )
    expect(result?.name).toBe(result?.phone)
  })

  it('falls back to now() for an invalid (out-of-range) timestamp, without throwing', () => {
    const before = Date.now()
    const result = parseInboundTextMessage(
      validPayload({ message: { messageTimestamp: 1 } }), // 1ms epoch — absurdly old
    )
    expect(result).not.toBeNull()
    const occurredAtMs = new Date(result!.occurredAt).getTime()
    expect(occurredAtMs).toBeGreaterThanOrEqual(before)
    expect(occurredAtMs).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('falls back to now() for a far-future timestamp', () => {
    const result = parseInboundTextMessage(
      validPayload({ message: { messageTimestamp: Date.now() + 365 * 24 * 60 * 60 * 1000 } }),
    )
    expect(result).not.toBeNull()
    expect(new Date(result!.occurredAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('accepts a plausible seconds-based timestamp by upgrading to ms', () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const result = parseInboundTextMessage(
      validPayload({ message: { messageTimestamp: nowSeconds } }),
    )
    expect(result).not.toBeNull()
    const diffMs = Math.abs(new Date(result!.occurredAt).getTime() - Date.now())
    expect(diffMs).toBeLessThan(5000)
  })
})
