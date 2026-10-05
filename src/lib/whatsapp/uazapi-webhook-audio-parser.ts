/**
 * Pure parser for a UAZAPI `messages` webhook event carrying an
 * inbound audio / voice note — no I/O, no DB access, fully
 * unit-testable with fixture payloads. Mirrors
 * `uazapi-webhook-image-parser.ts`'s conventions (same envelope, same
 * accept-only-in-scope philosophy) but is deliberately self-contained.
 *
 * Confirmed real shape (controlled capture of a real inbound voice
 * note, structure only):
 *   message.messageType = "AudioMessage", message.type = "media",
 *   message.mediaType = "ptt"
 * with `message.content` shaped as:
 *   { URL, directPath, fileLength, fileSHA256, fileEncSHA256, mediaKey,
 *     mediaKeyTimestamp, waveform, mimetype ("audio/ogg; codecs=opus"),
 *     seconds, PTT (true) }
 *
 * This module only ever reads `EventType`, `chat` (for the
 * `wa_isGroup` defense-in-depth check and phone hints), and a fixed
 * subset of `message`/`message.content`. It never reads — and
 * therefore can never leak into its return value — `URL`, `mediaKey`,
 * `fileSHA256`, `fileEncSHA256`, `directPath`, `waveform`, or
 * `contextInfo`. The stored file always comes from
 * `POST /message/download` (converted to MP3), never from `content.URL`.
 *
 * Scope: individual chats, inbound only. View-once audio is rejected
 * (same privacy rule as images). A regular (non-PTT) audio file is
 * accepted too when it carries the same `AudioMessage`/`media` shape
 * with an `audio/*` MIME type — `mediaType`, when present, must be
 * `ptt` or `audio`. Returns `null` for anything else.
 */

import { UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES } from './uazapi-api'

export interface ParsedInboundAudioMessage {
  /** Dedup key for `messages.message_id` — same field-selection logic as the other parsers (`messageid`, then `id`). */
  providerMessageId: string
  /** `message.id`, the `id` param for `POST /message/download` — same as the image/document parsers. */
  providerDownloadId: string
  chatId: string
  sender: string
  senderPn?: string
  chatPhone?: string
  chatWaChatid?: string
  senderName?: string
  /** ISO 8601 — the message's own timestamp when trustworthy, else a controlled "now" fallback. */
  occurredAt: string
  /** True for a WhatsApp voice note (`content.PTT === true` or `mediaType === "ptt"`). */
  isVoiceNote: boolean
  /** Declared duration in seconds, when present and sane. */
  durationSeconds?: number
  /** Declared source MIME type, normalized to its base type (e.g. `audio/ogg`). Metadata only — the stored file is MP3. */
  sourceMimeType: string
}

const MIN_REASONABLE_TIMESTAMP_MS = Date.UTC(2009, 0, 1)
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_REASONABLE_DURATION_SECONDS = 24 * 60 * 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function extractTimestamp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (ms >= MIN_REASONABLE_TIMESTAMP_MS && ms <= Date.now() + MAX_FUTURE_SKEW_MS) {
      return new Date(ms).toISOString()
    }
  }
  return new Date().toISOString()
}

/** `audio/ogg; codecs=opus` → `audio/ogg`. `null` unless it's a well-formed `audio/*` type. */
function normalizeAudioMimeType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const base = raw.split(';')[0].trim().toLowerCase()
  return /^audio\/[a-z0-9.+-]+$/.test(base) ? base : null
}

/** Declared size, number or numeric string (protobuf uint64 may arrive as either). `undefined` when absent/unparseable. */
function extractDeclaredSize(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isFinite(n) ? n : undefined
}

function extractDuration(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  if (raw < 0 || raw > MAX_REASONABLE_DURATION_SECONDS) return undefined
  return raw
}

/**
 * Parses a raw (`unknown`) UAZAPI webhook body into a
 * `ParsedInboundAudioMessage`, or `null` when the event is outside this
 * parser's scope. Never trusts a field's presence or type without
 * checking it first.
 */
export function parseInboundAudioMessage(payload: unknown): ParsedInboundAudioMessage | null {
  if (!isRecord(payload)) return null
  if (payload.EventType !== 'messages') return null

  const message = payload.message
  if (!isRecord(message)) return null

  const chat = isRecord(payload.chat) ? payload.chat : undefined

  // Individual, inbound, human-sent only — same guards as the other parsers.
  if (message.fromMe !== false) return null
  if (message.wasSentByApi !== false) return null
  if (message.isGroup !== false) return null
  if (chat && chat.wa_isGroup === true) return null

  if (message.messageType !== 'AudioMessage') return null
  if (message.type !== 'media') return null
  if (message.mediaType !== undefined && message.mediaType !== 'ptt' && message.mediaType !== 'audio') {
    return null
  }

  const content = message.content
  if (!isRecord(content)) return null

  // Privacy: view-once media is never persisted (same rule as images).
  if (content.viewOnce === true) return null

  const sourceMimeType = normalizeAudioMimeType(content.mimetype)
  if (!sourceMimeType) return null

  // Declared size is only a cheap pre-check — the real downloaded MP3
  // size is validated independently by the persist layer.
  const declaredSize = extractDeclaredSize(content.fileLength)
  if (declaredSize !== undefined && (declaredSize < 1 || declaredSize > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES)) {
    return null
  }

  const providerDownloadId = message.id
  if (typeof providerDownloadId !== 'string' || providerDownloadId.trim().length === 0) return null

  const providerMessageId = firstNonEmptyString([message.messageid, message.id])
  if (!providerMessageId) return null

  const chatId = message.chatid
  if (typeof chatId !== 'string' || chatId.trim().length === 0) return null

  const sender = message.sender
  if (typeof sender !== 'string' || sender.trim().length === 0) return null

  return {
    providerMessageId,
    providerDownloadId,
    chatId,
    sender,
    senderPn: optionalTrimmed(message.sender_pn),
    chatPhone: optionalTrimmed(chat?.phone),
    chatWaChatid: optionalTrimmed(chat?.wa_chatid),
    senderName: optionalTrimmed(message.senderName),
    occurredAt: extractTimestamp(message.messageTimestamp),
    isVoiceNote: content.PTT === true || message.mediaType === 'ptt',
    durationSeconds: extractDuration(content.seconds),
    sourceMimeType,
  }
}
