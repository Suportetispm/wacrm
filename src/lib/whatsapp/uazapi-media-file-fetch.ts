/**
 * Server-side download of a UAZAPI `fileURL` (returned by
 * `POST /message/download`), used ONLY by the inbound audio path.
 *
 * Until now no inbound path fetched `fileURL` server-side at all (the
 * document/image paths deliberately fail closed and use base64 — "FASE
 * 3.1"). Audio uses `generate_mp3: true` + `fileURL`, so this is the
 * minimal hardening for that one fetch, instead of a general-purpose
 * URL fetcher:
 *
 *   - SSRF: the URL must share the exact ORIGIN (protocol + host +
 *     port) of the already-trusted `UAZAPI_SERVER_URL`. Anything else —
 *     another host, a private IP, a different port/protocol — is
 *     refused before any request is made. No credentials in the URL.
 *   - No redirects (`redirect: 'manual'`; any 3xx is a failure), so a
 *     same-origin URL can't bounce the request somewhere else.
 *   - Timeout (AbortController) and a hard byte cap enforced WHILE
 *     streaming, not just via Content-Length.
 *   - Content-Type must be absent or audio-ish/octet-stream — an
 *     HTML/JSON error page is rejected even before the signature check.
 *   - The instance token is never sent with this request.
 *
 * Never logs the URL, its path, or any byte of the file.
 */

export const UAZAPI_FILE_FETCH_TIMEOUT_MS = 60_000

const ACCEPTED_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mpeg3',
  'audio/x-mpeg-3',
  'application/octet-stream',
])

export type UazapiFileFetchErrorCode =
  | 'url_not_allowed'
  | 'http_error'
  | 'redirect_refused'
  | 'content_type_refused'
  | 'too_large'
  | 'empty'
  | 'timeout'
  | 'network_error'

export class UazapiFileFetchError extends Error {
  readonly code: UazapiFileFetchErrorCode
  constructor(code: UazapiFileFetchErrorCode) {
    super(`UAZAPI file fetch failed: ${code}`)
    this.name = 'UazapiFileFetchError'
    this.code = code
  }
}

/** True only when `fileUrl` has the exact origin of the configured UAZAPI server and carries no credentials. */
export function isAllowedUazapiFileUrl(fileUrl: string, serverUrl: string | undefined): boolean {
  if (!serverUrl) return false
  let file: URL
  let server: URL
  try {
    file = new URL(fileUrl)
    server = new URL(serverUrl)
  } catch {
    return false
  }
  if (file.protocol !== 'https:' && file.protocol !== 'http:') return false
  if (file.username || file.password) return false
  return file.origin === server.origin
}

/**
 * Downloads `fileUrl` into memory with every guard above applied.
 * Resolves to the raw bytes and the (normalized) response Content-Type;
 * throws `UazapiFileFetchError` with a fixed code otherwise.
 */
export async function fetchUazapiMediaFile(args: {
  fileUrl: string
  maxBytes: number
  timeoutMs?: number
}): Promise<{ buffer: Buffer; contentType: string | null }> {
  const { fileUrl, maxBytes, timeoutMs = UAZAPI_FILE_FETCH_TIMEOUT_MS } = args

  if (!isAllowedUazapiFileUrl(fileUrl, process.env.UAZAPI_SERVER_URL)) {
    throw new UazapiFileFetchError('url_not_allowed')
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(fileUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch {
      throw new UazapiFileFetchError(timedOut ? 'timeout' : 'network_error')
    }

    if (response.status >= 300 && response.status < 400) {
      throw new UazapiFileFetchError('redirect_refused')
    }
    // `redirect: 'manual'` in some runtimes surfaces as an opaque
    // redirect (status 0) instead of a 3xx.
    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new UazapiFileFetchError('redirect_refused')
    }
    if (!response.ok) {
      throw new UazapiFileFetchError('http_error')
    }

    const rawContentType = response.headers.get('content-type')
    const contentType = rawContentType ? rawContentType.split(';')[0].trim().toLowerCase() : null
    if (contentType && !ACCEPTED_CONTENT_TYPES.has(contentType)) {
      throw new UazapiFileFetchError('content_type_refused')
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new UazapiFileFetchError('too_large')
    }

    const reader = response.body?.getReader()
    if (!reader) throw new UazapiFileFetchError('empty')

    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        throw new UazapiFileFetchError(timedOut ? 'timeout' : 'network_error')
      }
      if (result.done) break
      received += result.value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new UazapiFileFetchError('too_large')
      }
      chunks.push(Buffer.from(result.value))
    }

    if (received === 0) throw new UazapiFileFetchError('empty')
    return { buffer: Buffer.concat(chunks, received), contentType }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Real MP3 signature check — the declared MIME type is never trusted
 * alone. Accepts an ID3v2 tag (`49 44 33` = "ID3") or a valid MPEG
 * audio frame header: 11-bit frame sync (`FF Ex`/`FF Fx`), with the
 * reserved MPEG-version value (`01`) and reserved layer value (`00`)
 * both rejected so random `FF E?` bytes in, say, a text file don't pass.
 */
export function isMp3Buffer(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return true
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const versionBits = (buffer[1] >> 3) & 0x03
    const layerBits = (buffer[1] >> 1) & 0x03
    return versionBits !== 0x01 && layerBits !== 0x00
  }
  return false
}
