/**
 * TEMPORARY — UAZAPI profile-picture discovery. Remove once the real
 * behavior of `POST /chat/avatar` on this installation is confirmed.
 *
 * Off unless UAZAPI_AVATAR_DISCOVERY=1. For ONE inbound, individual,
 * already-persisted message per process, calls
 * `POST /chat/avatar { number: <parsed.chatId>, preview: true }` with
 * the token of the SAME connection the webhook was authenticated for
 * (resolved by the caller from the HMAC-validated config — never the
 * account's "primary" connection), and logs ONLY structure:
 *   status, response key names/types, hasUrl, protocol, hostname,
 *   port, sameOrigin, and whether chat.image / chat.imagePreview are
 *   present (names/types only).
 *
 * Never sends `force`, never requests the returned URL, never writes
 * anything, never logs the URL/path/query, chatId/JID/phone, token,
 * contact name, or any raw body.
 */

const LOG_PREFIX = '[uazapi/avatar-discovery]'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_CHARS = 64 * 1024

let captured = false

/** Test-only: resets the one-capture-per-process flag. */
export function __resetAvatarDiscoveryForTests(): void {
  captured = false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Individual chat ids only: a user JID, a LID, or bare digits. Groups (`@g.us`) and every other suffix are refused. */
function isIndividualChatId(chatId: string): boolean {
  const id = chatId.trim()
  if (id.length === 0) return false
  if (id.endsWith('@g.us')) return false
  if (!id.includes('@')) return /^\d{6,20}$/.test(id)
  return id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')
}

/**
 * True only when the env flag is exactly "1", no capture happened yet in
 * this process, and the raw payload is an inbound individual message
 * from someone else (independently re-checked here, on top of the
 * parsers that already enforce the same rules).
 */
export function shouldRunAvatarDiscovery(payload: unknown, chatId: unknown): boolean {
  if (process.env.UAZAPI_AVATAR_DISCOVERY !== '1') return false
  if (captured) return false
  if (!isRecord(payload) || payload.EventType !== 'messages') return false
  const message = payload.message
  if (!isRecord(message)) return false
  if (message.fromMe !== false) return false
  if (message.wasSentByApi === true) return false
  if (message.isGroup === true) return false
  const chat = isRecord(payload.chat) ? payload.chat : undefined
  if (chat?.wa_isGroup === true) return false
  return typeof chatId === 'string' && isIndividualChatId(chatId)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function safeKey(key: string): string {
  return key.length > 64 || key.includes('@') || /\d{6,}/.test(key) ? '<redacted-key>' : key
}

function safeHostname(value: string): string {
  return value.length <= 253 && /^[a-z0-9.-]+$/i.test(value) ? value : '<rejected>'
}

function chatImageInfo(payload: unknown) {
  const chat = isRecord(payload) && isRecord(payload.chat) ? payload.chat : undefined
  const image = chat?.image
  const preview = chat?.imagePreview
  return {
    chatImageType: chat && 'image' in chat ? typeName(image) : 'absent',
    chatImagePresent: typeof image === 'string' && image.trim().length > 0,
    chatImagePreviewType: chat && 'imagePreview' in chat ? typeName(preview) : 'absent',
    chatImagePreviewPresent: typeof preview === 'string' && preview.trim().length > 0,
  }
}

/**
 * Runs the single controlled call and logs the sanitized result. Never
 * throws. The capture flag is set before the call, so concurrent
 * deliveries can't double-capture.
 */
export async function runAvatarDiscovery(args: {
  payload: unknown
  chatId: string
  instanceToken: string
  maskedInstanceId: string
}): Promise<void> {
  if (captured) return
  captured = true

  const chatInfo = chatImageInfo(args.payload)
  const base = { instanceId: args.maskedInstanceId, ...chatInfo }
  const serverUrl = (process.env.UAZAPI_SERVER_URL ?? '').replace(/\/+$/, '')
  if (!serverUrl) {
    console.log(LOG_PREFIX, JSON.stringify({ ...base, code: 'server_url_missing' }))
    return
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetch(`${serverUrl}/chat/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: args.instanceToken },
        body: JSON.stringify({ number: args.chatId, preview: true }),
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch {
      console.log(LOG_PREFIX, JSON.stringify({ ...base, code: timedOut ? 'timeout' : 'network_error' }))
      return
    }

    if (response.status < 200 || response.status >= 300) {
      console.log(LOG_PREFIX, JSON.stringify({ ...base, status: response.status, code: 'http_error' }))
      return
    }

    let data: unknown
    try {
      const text = await response.text()
      if (text.length > MAX_RESPONSE_CHARS) {
        console.log(LOG_PREFIX, JSON.stringify({ ...base, status: '2xx', code: 'response_too_large' }))
        return
      }
      data = JSON.parse(text)
    } catch {
      console.log(LOG_PREFIX, JSON.stringify({ ...base, status: '2xx', code: 'response_not_json' }))
      return
    }
    if (!isRecord(data)) {
      console.log(LOG_PREFIX, JSON.stringify({ ...base, status: '2xx', code: 'response_not_object' }))
      return
    }

    const keys = Object.keys(data).sort()
    const responseTypes: Record<string, string> = {}
    for (const key of keys) responseTypes[safeKey(key)] = typeName(data[key])
    const responseKeys = keys.map(safeKey)

    const url = data.url
    const hasUrl = typeof url === 'string' && url.trim().length > 0
    let urlInfo: Record<string, unknown> = {}
    if (hasUrl) {
      let parsedUrl: URL | null = null
      try {
        parsedUrl = new URL(url as string)
      } catch {
        parsedUrl = null
      }
      if (!parsedUrl) {
        urlInfo = { code: 'url_invalid' }
      } else {
        let sameOrigin = false
        try {
          sameOrigin = parsedUrl.origin === new URL(serverUrl).origin
        } catch {
          sameOrigin = false
        }
        urlInfo = {
          protocol: parsedUrl.protocol,
          hostname: safeHostname(parsedUrl.hostname),
          port: parsedUrl.port,
          sameOrigin,
        }
      }
    }

    console.log(
      LOG_PREFIX,
      JSON.stringify({ ...base, status: '2xx', responseKeys, responseTypes, hasUrl, ...urlInfo }),
    )
  } catch {
    console.log(LOG_PREFIX, JSON.stringify({ ...base, code: 'unexpected_error' }))
  } finally {
    clearTimeout(timer)
  }
}
