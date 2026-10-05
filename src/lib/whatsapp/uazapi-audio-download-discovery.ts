/**
 * TEMPORARY — audio download discovery. Remove once the real origin of
 * `/message/download`'s `fileURL` is confirmed.
 *
 * Off unless UAZAPI_AUDIO_DOWNLOAD_DISCOVERY=1. For ONE inbound voice
 * note / audio per process, calls `POST /message/download` (via the
 * existing `downloadMessageMedia` helper — same auth, no second client)
 * with `generate_mp3: true`, `return_base64: false`,
 * `transcribe: false`, and logs ONLY:
 *   { status, mimetype, protocol, hostname, port, sameOrigin }
 * (+ a fixed `code` when fileURL is missing/invalid or the call fails).
 *
 * Never fetches/HEADs/follows the fileURL, never writes anything, never
 * logs the message id, token, URL path/query, or any raw body.
 */

import { downloadMessageMedia, UazapiHttpError, UazapiTimeoutError } from './uazapi-api'

const LOG_PREFIX = '[uazapi/audio-download-shape]'

let captured = false

/** Test-only: resets the one-capture-per-process flag. */
export function __resetAudioDownloadDiscoveryForTests(): void {
  captured = false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True only when the env flag is exactly "1" and the payload has the confirmed inbound audio shape. */
export function shouldRunAudioDownloadDiscovery(payload: unknown): boolean {
  if (process.env.UAZAPI_AUDIO_DOWNLOAD_DISCOVERY !== '1') return false
  if (!isRecord(payload) || payload.EventType !== 'messages') return false
  const message = payload.message
  if (!isRecord(message)) return false
  if (message.fromMe === true || message.wasSentByApi === true || message.isGroup === true) return false
  if (message.messageType !== 'AudioMessage' || message.type !== 'media') return false
  if (message.mediaType !== 'ptt' && message.mediaType !== 'audio') return false
  const content = message.content
  if (!isRecord(content) || typeof content.mimetype !== 'string') return false
  if (!content.mimetype.toLowerCase().startsWith('audio/')) return false
  return typeof message.id === 'string' && message.id.trim().length > 0
}

function safeMimeType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (v.length === 0 || v.length > 100) return undefined
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9.+-]+=[a-z0-9.+"-]+)*$/i.test(v) ? v : '<rejected>'
}

function safeHostname(value: string): string {
  return value.length <= 253 && /^[a-z0-9.-]+$/i.test(value) ? value : '<rejected>'
}

type DiscoveryLog =
  | {
      status: '2xx'
      mimetype?: string
      protocol: string
      hostname: string
      port: string
      sameOrigin: boolean
    }
  | { status: '2xx' | number | 'timeout' | 'network_error'; mimetype?: string; code: string }

/**
 * Runs the single controlled call and logs the sanitized result. Never
 * throws. At most one capture per process (the flag is set before the
 * call, so concurrent deliveries can't double-capture).
 */
export async function runAudioDownloadDiscovery(args: {
  payload: unknown
  instanceToken: string
  maskedInstanceId: string
}): Promise<void> {
  if (captured) return
  captured = true

  const message = isRecord(args.payload) && isRecord(args.payload.message) ? args.payload.message : undefined
  const id = typeof message?.id === 'string' ? message.id : ''

  let log: DiscoveryLog
  try {
    const result = await downloadMessageMedia({
      instanceToken: args.instanceToken,
      id,
      generateMp3: true,
      returnBase64: false,
      transcribe: false,
    })
    const mimetype = safeMimeType(result.mimetype)
    if (!result.fileUrl) {
      log = { status: '2xx', mimetype, code: 'file_url_missing' }
    } else {
      let file: URL | null = null
      try {
        file = new URL(result.fileUrl)
      } catch {
        file = null
      }
      if (!file) {
        log = { status: '2xx', mimetype, code: 'file_url_invalid' }
      } else {
        let sameOrigin = false
        try {
          sameOrigin = file.origin === new URL(process.env.UAZAPI_SERVER_URL ?? '').origin
        } catch {
          sameOrigin = false
        }
        log = {
          status: '2xx',
          mimetype,
          protocol: file.protocol,
          hostname: safeHostname(file.hostname),
          port: file.port,
          sameOrigin,
        }
      }
    }
  } catch (err) {
    if (err instanceof UazapiHttpError) log = { status: err.status, code: 'download_http_error' }
    else if (err instanceof UazapiTimeoutError) log = { status: 'timeout', code: 'download_timeout' }
    else log = { status: 'network_error', code: 'download_failed' }
  }

  console.log(LOG_PREFIX, JSON.stringify({ instanceId: args.maskedInstanceId, ...log }))
}
