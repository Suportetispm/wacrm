import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadMessageMedia,
  estimateBase64DecodedBytes,
  UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES,
} from './uazapi-api'

interface CapturedRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

let captured: CapturedRequest | null = null

function mockResponse(opts: {
  ok: boolean
  status?: number
  text: string
  contentLength?: string | null
}) {
  const headers = new Headers()
  if (opts.contentLength !== null) {
    headers.set('content-length', opts.contentLength ?? String(opts.text.length))
  }
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    headers,
    text: async () => opts.text,
    json: async () => JSON.parse(opts.text || '{}'),
  } as unknown as Response
}

function stubFetch(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured = {
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      }
      return response
    }),
  )
}

const BASE_ARGS = {
  instanceToken: 'test-instance-token',
  id: '7EB0F01D7244B421048F0706368376E0',
}

describe('downloadMessageMedia — request shape', () => {
  beforeEach(() => {
    captured = null
    process.env.UAZAPI_SERVER_URL = 'https://server.example.test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to /message/download with the token header', async () => {
    stubFetch(
      mockResponse({
        ok: true,
        text: JSON.stringify({ fileURL: 'https://cdn.example/file.mp3', mimetype: 'audio/mpeg' }),
      }),
    )
    await downloadMessageMedia(BASE_ARGS)
    expect(captured?.url).toBe('https://server.example.test/message/download')
    expect(captured?.method).toBe('POST')
    expect(captured?.headers?.token).toBe('test-instance-token')
    expect(captured?.headers?.['Content-Type']).toBe('application/json')
  })

  it('sends only "id" when no optional fields are provided — no undefined/null leaking in', async () => {
    stubFetch(mockResponse({ ok: true, text: JSON.stringify({}) }))
    await downloadMessageMedia(BASE_ARGS)
    expect(captured?.body).toEqual({ id: BASE_ARGS.id })
  })

  it('maps every optional field to its exact documented snake_case name', async () => {
    stubFetch(mockResponse({ ok: true, text: JSON.stringify({}) }))
    await downloadMessageMedia({
      ...BASE_ARGS,
      returnBase64: true,
      generateMp3: false,
      returnLink: false,
      transcribe: true,
      openaiApiKey: 'sk-test',
      downloadQuoted: true,
    })
    expect(captured?.body).toEqual({
      id: BASE_ARGS.id,
      return_base64: true,
      generate_mp3: false,
      return_link: false,
      transcribe: true,
      openai_apikey: 'sk-test',
      download_quoted: true,
    })
  })

  it('omits openai_apikey when not provided (falsy check, not just undefined check)', async () => {
    stubFetch(mockResponse({ ok: true, text: JSON.stringify({}) }))
    await downloadMessageMedia({ ...BASE_ARGS, openaiApiKey: '' })
    expect(captured?.body).toEqual({ id: BASE_ARGS.id })
  })
})

describe('downloadMessageMedia — response mapping', () => {
  beforeEach(() => {
    process.env.UAZAPI_SERVER_URL = 'https://server.example.test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps fileURL/mimetype/base64Data/transcription onto the typed result', async () => {
    stubFetch(
      mockResponse({
        ok: true,
        text: JSON.stringify({
          fileURL: 'https://cdn.example/file.mp3',
          mimetype: 'audio/mpeg',
          base64Data: 'AAAA',
          transcription: 'hello world',
        }),
      }),
    )
    const result = await downloadMessageMedia(BASE_ARGS)
    expect(result).toEqual({
      fileUrl: 'https://cdn.example/file.mp3',
      mimetype: 'audio/mpeg',
      base64Data: 'AAAA',
      transcription: 'hello world',
    })
  })

  it('leaves fields undefined when UAZAPI omits them', async () => {
    stubFetch(mockResponse({ ok: true, text: JSON.stringify({ fileURL: 'https://cdn.example/file.pdf' }) }))
    const result = await downloadMessageMedia(BASE_ARGS)
    expect(result).toEqual({ fileUrl: 'https://cdn.example/file.pdf' })
  })

  it('throws a sanitized UazapiHttpError on a non-2xx response', async () => {
    stubFetch(
      mockResponse({
        ok: false,
        status: 400,
        text: JSON.stringify({ error: 'Unsupported media type or no media found in message' }),
      }),
    )
    await expect(downloadMessageMedia(BASE_ARGS)).rejects.toThrow(
      /Unsupported media type or no media found in message/,
    )
  })
})

/** Base64 chars needed so decoding yields at least `decodedBytes` — rounded up to a multiple of 4 (no padding). */
function base64CharsForDecodedBytes(decodedBytes: number): number {
  return Math.ceil((decodedBytes * 4) / 3 / 4) * 4
}

describe('downloadMessageMedia — size limits (28 MB body / 20 MB decoded)', () => {
  const TWENTY_MB = 20 * 1024 * 1024
  const TWENTY_EIGHT_MB = 28 * 1024 * 1024

  beforeEach(() => {
    process.env.UAZAPI_SERVER_URL = 'https://server.example.test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the decoded-bytes limit is exported and set to 20 MB', () => {
    expect(UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES).toBe(TWENTY_MB)
  })

  it('rejects early from Content-Length alone (28 MB body cap), without needing to read the body', async () => {
    const response = mockResponse({
      ok: true,
      text: JSON.stringify({ fileURL: 'https://cdn.example/huge.bin' }),
      contentLength: String(TWENTY_EIGHT_MB + 1),
    })
    const textSpy = vi.spyOn(response, 'text')
    stubFetch(response)
    await expect(downloadMessageMedia(BASE_ARGS)).rejects.toThrow(/exceeded the .*-byte limit/)
    expect(textSpy).not.toHaveBeenCalled()
  })

  it('still validates the real body against the 28 MB cap when Content-Length is absent', async () => {
    const oversizedText = JSON.stringify({ fileURL: 'x'.repeat(TWENTY_EIGHT_MB + 1) })
    stubFetch(mockResponse({ ok: true, text: oversizedText, contentLength: null }))
    await expect(downloadMessageMedia(BASE_ARGS)).rejects.toThrow(/exceeded the .*-byte limit/)
  })

  it('still validates the real body when Content-Length under-reports the size (cannot be trusted alone)', async () => {
    const oversizedText = JSON.stringify({ fileURL: 'x'.repeat(TWENTY_EIGHT_MB + 1) })
    stubFetch(mockResponse({ ok: true, text: oversizedText, contentLength: '10' }))
    await expect(downloadMessageMedia(BASE_ARGS)).rejects.toThrow(/exceeded the .*-byte limit/)
  })

  it('accepts a non-base64 body right at the 28 MB limit', async () => {
    const overhead = JSON.stringify({ fileURL: '' }).length
    const text = JSON.stringify({ fileURL: 'x'.repeat(TWENTY_EIGHT_MB - overhead) })
    expect(text.length).toBe(TWENTY_EIGHT_MB)
    stubFetch(mockResponse({ ok: true, text, contentLength: null }))
    const result = await downloadMessageMedia(BASE_ARGS)
    expect(result.fileUrl?.length).toBe(TWENTY_EIGHT_MB - overhead)
  })

  it('REGRESSION: accepts a base64 payload that decodes to just under 20 MB, even though its base64 TEXT alone exceeds the old (pre-fix) 20 MB single limit', async () => {
    const decodedTarget = TWENTY_MB - 1024 * 1024 // 19 MB decoded
    const base64 = 'A'.repeat(base64CharsForDecodedBytes(decodedTarget))
    // Prove this is exactly the case the old single-20MB-raw-limit design
    // would have wrongly rejected: the base64 text itself is already
    // bigger than 20 MB, well before it's decoded.
    expect(base64.length).toBeGreaterThan(TWENTY_MB)
    expect(estimateBase64DecodedBytes(base64)).toBeLessThan(TWENTY_MB)

    const text = JSON.stringify({ base64Data: base64 })
    expect(text.length).toBeLessThan(TWENTY_EIGHT_MB) // fits comfortably under the new body cap
    stubFetch(mockResponse({ ok: true, text, contentLength: null }))

    const result = await downloadMessageMedia(BASE_ARGS)
    expect(result.base64Data).toBe(base64)
  })

  it('rejects a base64 payload that decodes to just over 20 MB, even though the raw body is well under the 28 MB body cap (decoded check is the one that fires, not the body check)', async () => {
    const decodedTarget = TWENTY_MB + 1000
    const base64 = 'A'.repeat(base64CharsForDecodedBytes(decodedTarget))
    const text = JSON.stringify({ base64Data: base64 })
    expect(text.length).toBeLessThan(TWENTY_EIGHT_MB) // the body check alone would NOT catch this
    stubFetch(mockResponse({ ok: true, text, contentLength: null }))

    await expect(downloadMessageMedia(BASE_ARGS)).rejects.toThrow(
      /exceeded the .*-byte limit after decoding/,
    )
  })

  it('the decode-size check computes the exact boundary correctly (unit-level)', () => {
    const base64CharsNeeded = base64CharsForDecodedBytes(TWENTY_MB)
    const oversizedBase64 = 'A'.repeat(base64CharsNeeded)
    expect(estimateBase64DecodedBytes(oversizedBase64)).toBeGreaterThan(TWENTY_MB)
  })

  it('never includes the base64 payload itself in a thrown error message', async () => {
    const decodedTarget = TWENTY_MB + 1000
    const oversizedBase64 = 'A'.repeat(base64CharsForDecodedBytes(decodedTarget))
    const text = JSON.stringify({ base64Data: oversizedBase64 })
    stubFetch(mockResponse({ ok: true, text, contentLength: null }))
    try {
      await downloadMessageMedia(BASE_ARGS)
      throw new Error('expected downloadMessageMedia to reject')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain('AAAA')
      expect(message.length).toBeLessThan(200)
    }
  })
})

describe('estimateBase64DecodedBytes', () => {
  it('computes the exact decoded length for no/1/2 padding characters', () => {
    expect(estimateBase64DecodedBytes('')).toBe(0)
    expect(estimateBase64DecodedBytes('QUJD')).toBe(3) // "ABC", no padding
    expect(estimateBase64DecodedBytes('QUI=')).toBe(2) // "AB", 1 padding char
    expect(estimateBase64DecodedBytes('QQ==')).toBe(1) // "A", 2 padding chars
  })

  it('matches Buffer.from(...).length for a real-world sample', () => {
    const sample = Buffer.from('the quick brown fox jumps over the lazy dog').toString('base64')
    expect(estimateBase64DecodedBytes(sample)).toBe(Buffer.from(sample, 'base64').length)
  })
})
