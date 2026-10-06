/**
 * Server-side download of a WhatsApp profile picture URL returned by
 * UAZAPI's `POST /chat/avatar`. A policy SEPARATE from the audio
 * downloader (`uazapi-media-file-fetch.ts`, same-origin with the UAZAPI
 * server) — the real avatar URLs live on WhatsApp's own CDN, confirmed
 * in production as `pps.whatsapp.net`.
 *
 *   - Exact host allowlist (`pps.whatsapp.net` only — never "any
 *     *.whatsapp.net", never "any https"), https only, default port,
 *     no credentials in the URL. Refused before any request is made.
 *   - No redirects (`redirect: 'manual'`; any 3xx is a failure).
 *   - No custom headers at all — the UAZAPI instance token is never
 *     sent to the CDN.
 *   - Timeout, and a hard byte cap enforced WHILE streaming.
 *   - Content-Type must be image/jpeg, image/png or image/webp, AND the
 *     real file signature must match it — HTML/JSON/SVG or any other
 *     content is refused.
 *
 * Never logs the URL, its path/query, or any byte of the file.
 */

export const WHATSAPP_AVATAR_ALLOWED_HOSTS: ReadonlySet<string> = new Set(['pps.whatsapp.net'])
export const WHATSAPP_AVATAR_MAX_BYTES = 1024 * 1024
export const WHATSAPP_AVATAR_FETCH_TIMEOUT_MS = 10_000

export type AvatarImageFormat = 'jpeg' | 'png' | 'webp'

const CONTENT_TYPE_TO_FORMAT: Record<string, AvatarImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export type WhatsAppAvatarFetchErrorCode =
  | 'url_not_allowed'
  | 'redirect_refused'
  | 'http_error'
  | 'content_type_refused'
  | 'too_large'
  | 'empty'
  | 'signature_mismatch'
  | 'timeout'
  | 'network_error'

export class WhatsAppAvatarFetchError extends Error {
  readonly code: WhatsAppAvatarFetchErrorCode
  constructor(code: WhatsAppAvatarFetchErrorCode) {
    super(`WhatsApp avatar fetch failed: ${code}`)
    this.name = 'WhatsAppAvatarFetchError'
    this.code = code
  }
}

/** True only for an https URL on an allowlisted host, default port, no credentials. */
export function isAllowedWhatsAppAvatarUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.port !== '') return false
  return WHATSAPP_AVATAR_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
}

/** Real image signature: JPEG `FF D8 FF`, PNG 8-byte signature, WebP `RIFF....WEBP`. */
export function detectAvatarImageFormat(buffer: Buffer): AvatarImageFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/**
 * Downloads and validates an avatar image. Resolves to the bytes and the
 * confirmed format; throws `WhatsAppAvatarFetchError` with a fixed code
 * otherwise.
 */
export async function fetchWhatsAppAvatarImage(args: {
  url: string
  maxBytes?: number
  timeoutMs?: number
}): Promise<{ buffer: Buffer; format: AvatarImageFormat }> {
  const { url, maxBytes = WHATSAPP_AVATAR_MAX_BYTES, timeoutMs = WHATSAPP_AVATAR_FETCH_TIMEOUT_MS } = args

  if (!isAllowedWhatsAppAvatarUrl(url)) throw new WhatsAppAvatarFetchError('url_not_allowed')

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      // Deliberately no headers: nothing of ours (token, cookies) ever reaches the CDN.
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch {
      throw new WhatsAppAvatarFetchError(timedOut ? 'timeout' : 'network_error')
    }

    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect' || response.status === 0) {
      throw new WhatsAppAvatarFetchError('redirect_refused')
    }
    if (!response.ok) throw new WhatsAppAvatarFetchError('http_error')

    const rawContentType = response.headers.get('content-type')
    const contentType = rawContentType ? rawContentType.split(';')[0].trim().toLowerCase() : ''
    const declaredFormat = CONTENT_TYPE_TO_FORMAT[contentType]
    if (!declaredFormat) throw new WhatsAppAvatarFetchError('content_type_refused')

    const declaredLength = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new WhatsAppAvatarFetchError('too_large')
    }

    const reader = response.body?.getReader()
    if (!reader) throw new WhatsAppAvatarFetchError('empty')

    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        throw new WhatsAppAvatarFetchError(timedOut ? 'timeout' : 'network_error')
      }
      if (result.done) break
      received += result.value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new WhatsAppAvatarFetchError('too_large')
      }
      chunks.push(Buffer.from(result.value))
    }
    if (received === 0) throw new WhatsAppAvatarFetchError('empty')

    const buffer = Buffer.concat(chunks, received)
    const realFormat = detectAvatarImageFormat(buffer)
    if (!realFormat || realFormat !== declaredFormat) {
      throw new WhatsAppAvatarFetchError('signature_mismatch')
    }
    return { buffer, format: realFormat }
  } finally {
    clearTimeout(timer)
  }
}
