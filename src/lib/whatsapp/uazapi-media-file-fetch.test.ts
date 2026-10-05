import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchUazapiMediaFile,
  isAllowedUazapiFileUrl,
  isMp3Buffer,
  UazapiFileFetchError,
} from './uazapi-media-file-fetch'

const SERVER = 'https://fixture.uazapi.test'
const FILE_URL = `${SERVER}/files/abc.mp3`

function id3Mp3(filler = 64): Buffer {
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x04, 0x00, 0x00]), Buffer.alloc(filler, 0x11)])
}
/** MPEG-1 Layer III frame header (FF FB) — the most common MP3 frame sync. */
function frameMp3(filler = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(filler, 0x22)])
}

function streamResponse(
  body: Buffer | string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'audio/mpeg' },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('UAZAPI_SERVER_URL', SERVER)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('isMp3Buffer', () => {
  it('accepts an ID3-tagged MP3', () => {
    expect(isMp3Buffer(id3Mp3())).toBe(true)
  })

  it('accepts a raw MPEG audio frame (FF Fx / FF Ex)', () => {
    expect(isMp3Buffer(frameMp3())).toBe(true)
    expect(isMp3Buffer(Buffer.from([0xff, 0xf3, 0x00]))).toBe(true) // MPEG-2 Layer III
    expect(isMp3Buffer(Buffer.from([0xff, 0xe3, 0x00]))).toBe(true) // MPEG-2.5 Layer III
  })

  it('rejects HTML, JSON, OGG, empty and reserved-bit frame headers', () => {
    expect(isMp3Buffer(Buffer.from('<!DOCTYPE html><html>'))).toBe(false)
    expect(isMp3Buffer(Buffer.from('{"error":"not found"}'))).toBe(false)
    expect(isMp3Buffer(Buffer.from('OggS\x00\x02', 'binary'))).toBe(false)
    expect(isMp3Buffer(Buffer.alloc(0))).toBe(false)
    expect(isMp3Buffer(Buffer.from([0xff, 0xe9]))).toBe(false) // reserved MPEG version (01)
    expect(isMp3Buffer(Buffer.from([0xff, 0xf9]))).toBe(false) // reserved layer (00)
  })
})

describe('isAllowedUazapiFileUrl', () => {
  it('allows only the exact origin of UAZAPI_SERVER_URL', () => {
    expect(isAllowedUazapiFileUrl(FILE_URL, SERVER)).toBe(true)
    expect(isAllowedUazapiFileUrl('https://evil.test/files/a.mp3', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('http://fixture.uazapi.test/files/a.mp3', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('https://fixture.uazapi.test:8443/a.mp3', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('https://169.254.169.254/latest/meta-data', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('https://user:pass@fixture.uazapi.test/a.mp3', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('file:///etc/passwd', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl('not a url', SERVER)).toBe(false)
    expect(isAllowedUazapiFileUrl(FILE_URL, undefined)).toBe(false)
  })
})

describe('fetchUazapiMediaFile', () => {
  it('downloads a same-origin MP3 without redirects and without sending any token', async () => {
    fetchMock.mockResolvedValue(streamResponse(id3Mp3()))
    const { buffer, contentType } = await fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 })
    expect(isMp3Buffer(buffer)).toBe(true)
    expect(contentType).toBe('audio/mpeg')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe('manual')
    expect(init.headers).toBeUndefined()
  })

  async function expectCode(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toBeInstanceOf(UazapiFileFetchError)
    await promise.catch((err: UazapiFileFetchError) => expect(err.code).toBe(code))
  }

  it('refuses a foreign host before making any request (SSRF)', async () => {
    await expectCode(fetchUazapiMediaFile({ fileUrl: 'https://evil.test/a.mp3', maxBytes: 1024 }), 'url_not_allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect', async () => {
    fetchMock.mockResolvedValue(streamResponse('', { status: 302, headers: { location: 'https://evil.test' } }))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'redirect_refused')
  })

  it('refuses a non-2xx response', async () => {
    fetchMock.mockResolvedValue(streamResponse('gone', { status: 404, headers: { 'content-type': 'audio/mpeg' } }))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'http_error')
  })

  it('refuses an HTML/JSON content type', async () => {
    fetchMock.mockResolvedValue(streamResponse('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'content_type_refused')
    fetchMock.mockResolvedValue(streamResponse('{}', { headers: { 'content-type': 'application/json' } }))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'content_type_refused')
  })

  it('enforces the byte cap while streaming, even without a Content-Length', async () => {
    fetchMock.mockResolvedValue(streamResponse(frameMp3(2048)))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'too_large')
  })

  it('refuses an empty body', async () => {
    fetchMock.mockResolvedValue(streamResponse(Buffer.alloc(0)))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'empty')
  })

  it('maps a network failure to a fixed code', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expectCode(fetchUazapiMediaFile({ fileUrl: FILE_URL, maxBytes: 1024 }), 'network_error')
  })
})
