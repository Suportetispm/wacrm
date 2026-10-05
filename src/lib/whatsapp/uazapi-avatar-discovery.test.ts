// TEMPORARY — tests for uazapi-avatar-discovery.ts. Remove with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAvatarDiscoveryForTests,
  runAvatarDiscovery,
  shouldRunAvatarDiscovery,
} from './uazapi-avatar-discovery'

const SERVER = 'https://fixture.uazapi.test'
const PREFIX = '[uazapi/avatar-discovery]'

const SECRET_TOKEN = 'SECRET_INSTANCE_TOKEN_SHOULD_NOT_APPEAR'
const PRIVATE_CHAT_ID = '5591987654321@s.whatsapp.net'
const PRIVATE_PATH = 'PRIVATE_AVATAR_PATH_SHOULD_NOT_APPEAR'
const PRIVATE_QUERY = 'PRIVATE_QUERY_SHOULD_NOT_APPEAR'

function inbound(overrides: { message?: Record<string, unknown>; chat?: Record<string, unknown> } = {}) {
  return {
    EventType: 'messages',
    token: 'SECRET_ENVELOPE_TOKEN_SHOULD_NOT_APPEAR',
    owner: 'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
    chat: {
      phone: 'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
      name: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
      wa_chatid: PRIVATE_CHAT_ID,
      wa_isGroup: false,
      image: 'https://pps.whatsapp.net/PRIVATE_CHAT_IMAGE_SHOULD_NOT_APPEAR',
      imagePreview: '',
      ...overrides.chat,
    },
    message: {
      id: 'PRIVATE_MESSAGE_ID_SHOULD_NOT_APPEAR',
      chatid: PRIVATE_CHAT_ID,
      sender: PRIVATE_CHAT_ID,
      senderName: 'PRIVATE_NAME_SHOULD_NOT_APPEAR',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      ...overrides.message,
    },
  }
}

const SENSITIVE = [
  SECRET_TOKEN,
  PRIVATE_CHAT_ID,
  '5591987654321',
  PRIVATE_PATH,
  PRIVATE_QUERY,
  'SECRET_ENVELOPE_TOKEN_SHOULD_NOT_APPEAR',
  'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
  'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
  'PRIVATE_NAME_SHOULD_NOT_APPEAR',
  'PRIVATE_MESSAGE_ID_SHOULD_NOT_APPEAR',
  'PRIVATE_CHAT_IMAGE_SHOULD_NOT_APPEAR',
  'RAW_BODY_SHOULD_NOT_APPEAR',
]

const fetchMock = vi.fn()
let logSpy: ReturnType<typeof vi.spyOn>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function logs() {
  return logSpy.mock.calls.filter((a: unknown[]) => a[0] === PREFIX)
}
function parsedLog() {
  return JSON.parse(logs()[0][1] as string)
}

async function run(payload: unknown = inbound(), chatId = PRIVATE_CHAT_ID) {
  await runAvatarDiscovery({ payload, chatId, instanceToken: SECRET_TOKEN, maskedInstanceId: 'fix…id' })
}

beforeEach(() => {
  __resetAvatarDiscoveryForTests()
  vi.stubEnv('UAZAPI_SERVER_URL', SERVER)
  vi.stubEnv('UAZAPI_AVATAR_DISCOVERY', '1')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('shouldRunAvatarDiscovery — gate', () => {
  it('variable absent → never runs', () => {
    vi.stubEnv('UAZAPI_AVATAR_DISCOVERY', '')
    expect(shouldRunAvatarDiscovery(inbound(), PRIVATE_CHAT_ID)).toBe(false)
  })

  it('variable different from exactly "1" → never runs', () => {
    for (const v of ['true', '0', 'yes', ' 1', '1 ']) {
      vi.stubEnv('UAZAPI_AVATAR_DISCOVERY', v)
      expect(shouldRunAvatarDiscovery(inbound(), PRIVATE_CHAT_ID)).toBe(false)
    }
  })

  it('accepts an inbound individual message (user JID, LID, bare digits)', () => {
    expect(shouldRunAvatarDiscovery(inbound(), PRIVATE_CHAT_ID)).toBe(true)
    expect(shouldRunAvatarDiscovery(inbound(), '123456789012345@lid')).toBe(true)
    expect(shouldRunAvatarDiscovery(inbound(), '5591987654321')).toBe(true)
  })

  it('groups → never runs (@g.us, message.isGroup, chat.wa_isGroup)', () => {
    expect(shouldRunAvatarDiscovery(inbound(), '120363000000000000@g.us')).toBe(false)
    expect(shouldRunAvatarDiscovery(inbound({ message: { isGroup: true } }), PRIVATE_CHAT_ID)).toBe(false)
    expect(shouldRunAvatarDiscovery(inbound({ chat: { wa_isGroup: true } }), PRIVATE_CHAT_ID)).toBe(false)
  })

  it('fromMe (or fromMe not explicitly false) → never runs', () => {
    expect(shouldRunAvatarDiscovery(inbound({ message: { fromMe: true } }), PRIVATE_CHAT_ID)).toBe(false)
    expect(shouldRunAvatarDiscovery(inbound({ message: { fromMe: undefined } }), PRIVATE_CHAT_ID)).toBe(false)
  })

  it('API echo → never runs', () => {
    expect(shouldRunAvatarDiscovery(inbound({ message: { wasSentByApi: true } }), PRIVATE_CHAT_ID)).toBe(false)
  })

  it('other suffixes / empty ids / non-message events → never run', () => {
    expect(shouldRunAvatarDiscovery(inbound(), '123@newsletter')).toBe(false)
    expect(shouldRunAvatarDiscovery(inbound(), 'status@broadcast')).toBe(false)
    expect(shouldRunAvatarDiscovery(inbound(), '')).toBe(false)
    expect(shouldRunAvatarDiscovery({ EventType: 'connection' }, PRIVATE_CHAT_ID)).toBe(false)
  })

  it('stops passing once a capture already happened in this process', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))
    await run()
    expect(shouldRunAvatarDiscovery(inbound(), PRIVATE_CHAT_ID)).toBe(false)
  })
})

describe('runAvatarDiscovery — the single controlled call', () => {
  it('one POST /chat/avatar with { number: chatId, preview: true }, token header of the given connection, no force', async () => {
    fetchMock.mockResolvedValue(json({ url: `https://pps.whatsapp.net/v/${PRIVATE_PATH}.jpg?oh=${PRIVATE_QUERY}` }))

    await run()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${SERVER}/chat/avatar`)
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe(SECRET_TOKEN)
    const body = JSON.parse(init.body)
    expect(body).toEqual({ number: PRIVATE_CHAT_ID, preview: true })
    expect(body).not.toHaveProperty('force')
  })

  it('never requests the returned URL (exactly one fetch, to /chat/avatar)', async () => {
    fetchMock.mockResolvedValue(json({ url: `https://pps.whatsapp.net/v/${PRIVATE_PATH}.jpg` }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.every(([u]) => String(u) === `${SERVER}/chat/avatar`)).toBe(true)
  })

  it('URL present (CDN) → only structural fields, sameOrigin=false', async () => {
    fetchMock.mockResolvedValue(json({ url: `https://pps.whatsapp.net/v/${PRIVATE_PATH}.jpg?oh=${PRIVATE_QUERY}` }))
    await run()
    expect(logs()).toHaveLength(1)
    expect(parsedLog()).toEqual({
      instanceId: 'fix…id',
      chatImageType: 'string',
      chatImagePresent: true,
      chatImagePreviewType: 'string',
      chatImagePreviewPresent: false,
      status: '2xx',
      responseKeys: ['url'],
      responseTypes: { url: 'string' },
      hasUrl: true,
      protocol: 'https:',
      hostname: 'pps.whatsapp.net',
      port: '',
      sameOrigin: false,
    })
  })

  it('same-origin URL → sameOrigin=true', async () => {
    fetchMock.mockResolvedValue(json({ url: `${SERVER}/files/${PRIVATE_PATH}.jpg` }))
    await run()
    expect(parsedLog()).toMatchObject({ hostname: 'fixture.uazapi.test', sameOrigin: true })
  })

  it('empty url → hasUrl=false and no URL fields', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))
    await run(inbound({ chat: { image: undefined, imagePreview: undefined } }))
    const log = parsedLog()
    expect(log).toMatchObject({ status: '2xx', responseKeys: ['url'], hasUrl: false })
    expect(log).not.toHaveProperty('hostname')
    expect(log).not.toHaveProperty('protocol')
  })

  it('reports chat.image/imagePreview as "absent" when the webhook chat has no such keys', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))
    const payload = inbound()
    delete (payload.chat as Record<string, unknown>).image
    delete (payload.chat as Record<string, unknown>).imagePreview
    await run(payload)
    expect(parsedLog()).toMatchObject({
      chatImageType: 'absent',
      chatImagePresent: false,
      chatImagePreviewType: 'absent',
      chatImagePreviewPresent: false,
    })
  })

  it('invalid url string → fixed code only', async () => {
    fetchMock.mockResolvedValue(json({ url: 'RAW_BODY_SHOULD_NOT_APPEAR not a url' }))
    await run()
    expect(parsedLog()).toMatchObject({ hasUrl: true, code: 'url_invalid' })
  })

  it.each([429, 500, 401, 400])('HTTP %i → status + fixed code, never throws', async (status) => {
    fetchMock.mockResolvedValue(json({ error: 'RAW_BODY_SHOULD_NOT_APPEAR' }, status))
    await expect(run()).resolves.toBeUndefined()
    expect(parsedLog()).toMatchObject({ status, code: 'http_error' })
  })

  it('network failure / non-JSON body → fixed codes, never throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(run()).resolves.toBeUndefined()
    expect(parsedLog()).toMatchObject({ code: 'network_error' })

    __resetAvatarDiscoveryForTests()
    logSpy.mockClear()
    fetchMock.mockResolvedValueOnce(new Response('RAW_BODY_SHOULD_NOT_APPEAR', { status: 200 }))
    await expect(run()).resolves.toBeUndefined()
    expect(parsedLog()).toMatchObject({ status: '2xx', code: 'response_not_json' })
  })

  it('at most one capture per process', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))
    await run()
    await run()
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logs()).toHaveLength(1)
  })

  it('no URL/path/query, chatId/JID/phone, token, name, or raw body ever appears in any console.log argument', async () => {
    fetchMock.mockResolvedValue(
      json({ url: `https://pps.whatsapp.net/v/${PRIVATE_PATH}.jpg?oh=${PRIVATE_QUERY}`, extra: 'RAW_BODY_SHOULD_NOT_APPEAR' }),
    )
    await run()
    const serialized = logSpy.mock.calls
      .flat()
      .map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    for (const marker of SENSITIVE) expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain('/v/')
  })
})
