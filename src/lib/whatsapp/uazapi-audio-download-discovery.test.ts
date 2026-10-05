// TEMPORARY — tests for uazapi-audio-download-discovery.ts. Remove with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAudioDownloadDiscoveryForTests,
  runAudioDownloadDiscovery,
  shouldRunAudioDownloadDiscovery,
} from './uazapi-audio-download-discovery'

const SERVER = 'https://fixture.uazapi.test'
const PREFIX = '[uazapi/audio-download-shape]'

const SECRET_MESSAGE_ID = 'PRIVATE_MESSAGE_ID_SHOULD_NOT_APPEAR'
const SECRET_TOKEN = 'SECRET_TOKEN_SHOULD_NOT_APPEAR'
const SECRET_PATH = 'PRIVATE_PATH_SHOULD_NOT_APPEAR'
const SECRET_QUERY = 'PRIVATE_QUERY_SHOULD_NOT_APPEAR'

function voiceNote(overrides: { message?: Record<string, unknown>; content?: Record<string, unknown> } = {}) {
  return {
    EventType: 'messages',
    token: SECRET_TOKEN,
    owner: 'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
    message: {
      id: SECRET_MESSAGE_ID,
      messageid: 'PRIVATE_MESSAGEID_SHOULD_NOT_APPEAR',
      chatid: 'PRIVATE_JID_SHOULD_NOT_APPEAR@s.whatsapp.net',
      sender: 'PRIVATE_PHONE_SHOULD_NOT_APPEAR@s.whatsapp.net',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      messageType: 'AudioMessage',
      type: 'media',
      mediaType: 'ptt',
      content: {
        URL: 'https://PRIVATE_URL_SHOULD_NOT_APPEAR.test/x',
        mediaKey: 'PRIVATE_MEDIAKEY_SHOULD_NOT_APPEAR',
        directPath: '/PRIVATE_DIRECTPATH_SHOULD_NOT_APPEAR',
        mimetype: 'audio/ogg; codecs=opus',
        PTT: true,
        seconds: 3,
        ...overrides.content,
      },
      ...overrides.message,
    },
  }
}

const SENSITIVE = [
  SECRET_MESSAGE_ID,
  SECRET_TOKEN,
  SECRET_PATH,
  SECRET_QUERY,
  'PRIVATE_OWNER_SHOULD_NOT_APPEAR',
  'PRIVATE_MESSAGEID_SHOULD_NOT_APPEAR',
  'PRIVATE_JID_SHOULD_NOT_APPEAR',
  'PRIVATE_PHONE_SHOULD_NOT_APPEAR',
  'PRIVATE_URL_SHOULD_NOT_APPEAR',
  'PRIVATE_MEDIAKEY_SHOULD_NOT_APPEAR',
  'PRIVATE_DIRECTPATH_SHOULD_NOT_APPEAR',
  'RAW_BODY_SHOULD_NOT_APPEAR',
]

const fetchMock = vi.fn()
let logSpy: ReturnType<typeof vi.spyOn>

function downloadResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function shapeLogs() {
  return logSpy.mock.calls.filter((a: unknown[]) => a[0] === PREFIX)
}
function parsedLog() {
  return JSON.parse(shapeLogs()[0][1] as string)
}

async function run(payload: unknown = voiceNote()) {
  await runAudioDownloadDiscovery({ payload, instanceToken: SECRET_TOKEN, maskedInstanceId: 'fix…id' })
}

beforeEach(() => {
  __resetAudioDownloadDiscoveryForTests()
  vi.stubEnv('UAZAPI_SERVER_URL', SERVER)
  vi.stubEnv('UAZAPI_AUDIO_DOWNLOAD_DISCOVERY', '1')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('shouldRunAudioDownloadDiscovery — gate', () => {
  it('1: variable absent → never runs', () => {
    vi.stubEnv('UAZAPI_AUDIO_DOWNLOAD_DISCOVERY', '')
    expect(shouldRunAudioDownloadDiscovery(voiceNote())).toBe(false)
  })

  it('2: any value other than exactly "1" → never runs', () => {
    for (const v of ['true', '0', 'yes', ' 1']) {
      vi.stubEnv('UAZAPI_AUDIO_DOWNLOAD_DISCOVERY', v)
      expect(shouldRunAudioDownloadDiscovery(voiceNote())).toBe(false)
    }
  })

  it('accepts the confirmed real shape (ptt and audio)', () => {
    expect(shouldRunAudioDownloadDiscovery(voiceNote())).toBe(true)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { mediaType: 'audio' } }))).toBe(true)
  })

  it('rejects fromMe / API echoes / groups / other types / non-audio MIME / missing id', () => {
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { fromMe: true } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { wasSentByApi: true } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { isGroup: true } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { messageType: 'ImageMessage' } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { type: 'text' } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { mediaType: 'video' } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ content: { mimetype: 'image/jpeg' } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery(voiceNote({ message: { id: '' } }))).toBe(false)
    expect(shouldRunAudioDownloadDiscovery({ EventType: 'connection' })).toBe(false)
  })
})

describe('runAudioDownloadDiscovery — the single controlled call', () => {
  it('3–7: exactly one POST /message/download with generate_mp3=true, return_base64=false, transcribe=false — and no request to the fileURL', async () => {
    fetchMock.mockResolvedValue(
      downloadResponse({ fileURL: `${SERVER}/files/${SECRET_PATH}.mp3?sig=${SECRET_QUERY}`, mimetype: 'audio/mpeg' }),
    )

    await run()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${SERVER}/message/download`)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      id: SECRET_MESSAGE_ID,
      generate_mp3: true,
      return_base64: false,
      transcribe: false,
    })
    // 7: nothing else was requested — no GET/HEAD on the fileURL.
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('/files/'))).toBe(true)
  })

  it('10 + 12: same-origin fileURL → only the allowed fields, sameOrigin=true', async () => {
    fetchMock.mockResolvedValue(
      downloadResponse({ fileURL: `${SERVER}/files/${SECRET_PATH}.mp3?sig=${SECRET_QUERY}`, mimetype: 'audio/mpeg' }),
    )

    await run()

    expect(shapeLogs()).toHaveLength(1)
    expect(parsedLog()).toEqual({
      instanceId: 'fix…id',
      status: '2xx',
      mimetype: 'audio/mpeg',
      protocol: 'https:',
      hostname: 'fixture.uazapi.test',
      port: '',
      sameOrigin: true,
    })
  })

  it('13: another host (CDN) → sameOrigin=false, with protocol/hostname/port', async () => {
    fetchMock.mockResolvedValue(
      downloadResponse({ fileURL: `https://cdn.example-files.test:8443/${SECRET_PATH}.mp3?${SECRET_QUERY}`, mimetype: 'audio/mpeg' }),
    )

    await run()

    expect(parsedLog()).toMatchObject({
      protocol: 'https:',
      hostname: 'cdn.example-files.test',
      port: '8443',
      sameOrigin: false,
    })
  })

  it('14: missing or invalid fileURL → a fixed structural code, never the raw response', async () => {
    fetchMock.mockResolvedValueOnce(downloadResponse({ mimetype: 'audio/mpeg', other: 'RAW_BODY_SHOULD_NOT_APPEAR' }))
    await run()
    expect(parsedLog()).toEqual({ instanceId: 'fix…id', status: '2xx', mimetype: 'audio/mpeg', code: 'file_url_missing' })

    __resetAudioDownloadDiscoveryForTests()
    logSpy.mockClear()
    fetchMock.mockResolvedValueOnce(downloadResponse({ fileURL: 'RAW_BODY_SHOULD_NOT_APPEAR not a url', mimetype: 'audio/mpeg' }))
    await run()
    expect(parsedLog()).toEqual({ instanceId: 'fix…id', status: '2xx', mimetype: 'audio/mpeg', code: 'file_url_invalid' })
  })

  it('an HTTP error from /message/download logs only its status and a fixed code', async () => {
    fetchMock.mockResolvedValue(downloadResponse({ error: 'RAW_BODY_SHOULD_NOT_APPEAR' }, 404))
    await run()
    expect(parsedLog()).toEqual({ instanceId: 'fix…id', status: 404, code: 'download_http_error' })
  })

  it('at most one capture per process', async () => {
    fetchMock.mockResolvedValue(downloadResponse({ fileURL: `${SERVER}/f.mp3`, mimetype: 'audio/mpeg' }))
    await run()
    await run()
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(shapeLogs()).toHaveLength(1)
  })

  it('11: no sensitive value appears in any argument of any console.log call', async () => {
    fetchMock.mockResolvedValue(
      downloadResponse({
        fileURL: `${SERVER}/files/${SECRET_PATH}.mp3?sig=${SECRET_QUERY}`,
        mimetype: 'audio/mpeg',
        extra: 'RAW_BODY_SHOULD_NOT_APPEAR',
      }),
    )
    await run()
    const serialized = logSpy.mock.calls.flat().map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
    for (const marker of SENSITIVE) expect(serialized).not.toContain(marker)
  })
})
