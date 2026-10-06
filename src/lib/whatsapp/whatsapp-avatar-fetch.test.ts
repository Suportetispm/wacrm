import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectAvatarImageFormat,
  fetchWhatsAppAvatarImage,
  isAllowedWhatsAppAvatarUrl,
  WhatsAppAvatarFetchError,
} from './whatsapp-avatar-fetch'

const URL_OK = 'https://pps.whatsapp.net/v/t61.24694-24/123_n.jpg?ccb=11-4&oh=abc&oe=def'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x22)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 0x33)])

function image(body: Buffer | string, contentType: string | null = 'image/jpeg', status = 200, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (contentType) headers['content-type'] = contentType
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.catch((e) => e)
  expect(err).toBeInstanceOf(WhatsAppAvatarFetchError)
  expect((err as WhatsAppAvatarFetchError).code).toBe(code)
}

describe('isAllowedWhatsAppAvatarUrl — avatar-specific policy', () => {
  it('accepts https://pps.whatsapp.net only', () => {
    expect(isAllowedWhatsAppAvatarUrl(URL_OK)).toBe(true)
    expect(isAllowedWhatsAppAvatarUrl('https://PPS.WHATSAPP.NET/x.jpg')).toBe(true)
  })

  it('refuses http, other hosts, sibling *.whatsapp.net hosts, ports, credentials and non-URLs', () => {
    expect(isAllowedWhatsAppAvatarUrl('http://pps.whatsapp.net/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://mmg.whatsapp.net/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://pps.whatsapp.net.evil.test/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://evil.test/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://pps.whatsapp.net:8443/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('https://u:p@pps.whatsapp.net/x.jpg')).toBe(false)
    expect(isAllowedWhatsAppAvatarUrl('not a url')).toBe(false)
  })
})

describe('detectAvatarImageFormat', () => {
  it('recognizes JPEG, PNG and WebP; rejects HTML, JSON and SVG', () => {
    expect(detectAvatarImageFormat(JPEG)).toBe('jpeg')
    expect(detectAvatarImageFormat(PNG)).toBe('png')
    expect(detectAvatarImageFormat(WEBP)).toBe('webp')
    expect(detectAvatarImageFormat(Buffer.from('<!DOCTYPE html><html>'))).toBeNull()
    expect(detectAvatarImageFormat(Buffer.from('{"error":"x"}'))).toBeNull()
    expect(detectAvatarImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})

describe('fetchWhatsAppAvatarImage', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'jpeg'],
    ['PNG', PNG, 'image/png', 'png'],
    ['WebP', WEBP, 'image/webp', 'webp'],
  ] as const)('accepts a valid %s', async (_label, buf, ct, format) => {
    fetchMock.mockResolvedValue(image(buf, ct))
    const result = await fetchWhatsAppAvatarImage({ url: URL_OK })
    expect(result.format).toBe(format)
    expect(result.buffer.equals(buf)).toBe(true)
  })

  it('sends no headers at all (the UAZAPI token never reaches the CDN) and never follows redirects', async () => {
    fetchMock.mockResolvedValue(image(JPEG))
    await fetchWhatsAppAvatarImage({ url: URL_OK })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(URL_OK)
    expect(init.headers).toBeUndefined()
    expect(init.redirect).toBe('manual')
  })

  it('refuses a disallowed URL before any request', async () => {
    await expectCode(fetchWhatsAppAvatarImage({ url: 'http://pps.whatsapp.net/x.jpg' }), 'url_not_allowed')
    await expectCode(fetchWhatsAppAvatarImage({ url: 'https://evil.test/x.jpg' }), 'url_not_allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect', async () => {
    fetchMock.mockResolvedValue(image('', null, 302, { location: 'https://evil.test/x.jpg' }))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'redirect_refused')
  })

  it('refuses a non-2xx response', async () => {
    fetchMock.mockResolvedValue(image('nope', 'image/jpeg', 403))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'http_error')
  })

  it.each([
    ['HTML', 'text/html; charset=utf-8'],
    ['JSON', 'application/json'],
    ['SVG', 'image/svg+xml'],
    ['GIF', 'image/gif'],
    ['missing', null],
  ])('refuses a %s content type', async (_label, ct) => {
    fetchMock.mockResolvedValue(image(JPEG, ct))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'content_type_refused')
  })

  it('refuses HTML disguised as image/jpeg (real signature check)', async () => {
    fetchMock.mockResolvedValue(image('<!DOCTYPE html><html>error</html>', 'image/jpeg'))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'signature_mismatch')
  })

  it('refuses a declared MIME that disagrees with the real bytes (PNG sent as image/jpeg)', async () => {
    fetchMock.mockResolvedValue(image(PNG, 'image/jpeg'))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'signature_mismatch')
  })

  it('refuses a body above the limit, even without Content-Length (streaming cap)', async () => {
    fetchMock.mockResolvedValue(image(Buffer.concat([JPEG, Buffer.alloc(2048)]), 'image/jpeg'))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK, maxBytes: 1024 }), 'too_large')
  })

  it('refuses a declared Content-Length above the limit', async () => {
    fetchMock.mockResolvedValue(image(JPEG, 'image/jpeg', 200, { 'content-length': String(5 * 1024 * 1024) }))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'too_large')
  })

  it('refuses an empty body', async () => {
    fetchMock.mockResolvedValue(image(Buffer.alloc(0), 'image/jpeg'))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'empty')
  })

  it('times out', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK, timeoutMs: 20 }), 'timeout')
  })

  it('maps a network failure to a fixed code', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expectCode(fetchWhatsAppAvatarImage({ url: URL_OK }), 'network_error')
  })
})
