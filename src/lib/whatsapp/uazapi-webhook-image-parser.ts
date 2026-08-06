/**
 * Pure parser for a UAZAPI `messages` webhook event carrying an
 * inbound image — no I/O, no DB access, fully unit-testable with
 * fixture payloads. Mirrors `uazapi-webhook-document-parser.ts`'s
 * conventions (same envelope shape, same accept-only-in-scope
 * philosophy) but is deliberately self-contained.
 *
 * Confirmed real envelope (FASE 4A, a live ImageMessage capture via
 * TEMP_IMAGE_SHAPE_DISCOVERY):
 *   { EventType, chat, chatSource, message, instanceName, owner, BaseUrl, token }
 * with `message.content` shaped as:
 *   { URL, mimetype, fileSHA256, fileLength, height, width, mediaKey,
 *     fileEncSHA256, directPath, mediaKeyTimestamp, contextInfo, viewOnce }
 *
 * Notably, unlike DocumentMessage, the real payload has no
 * `content.fileName`, no `content.caption`, and no JPEG thumbnail
 * field — a caption, when present, is expected in `message.text` (same
 * field the document parser reads), and a stable, non-personal file
 * name is generated from the MIME type since none is ever provided.
 *
 * This module only ever reads `EventType`, `chat` (for the
 * `wa_isGroup` defense-in-depth check), and a fixed subset of
 * `message`/`message.content`. It never reads — and therefore can
 * never accidentally leak into its return value — `URL`, `mediaKey`,
 * `fileSHA256`, `fileEncSHA256`, `directPath`, any thumbnail field, or
 * the raw `contextInfo` object.
 *
 * Privacy: `content.viewOnce === true` is rejected unconditionally and
 * explicitly, before any other field is read — WhatsApp "view once"
 * media must never be persisted, regardless of MIME type or size. This
 * is a deliberate product/privacy decision, not an incidental filter.
 *
 * Scope for this stage: JPEG/PNG/WebP only, individual chats only,
 * inbound only. Returns `null` for anything else — other image MIME
 * types, documents/audio/video, groups, `fromMe`, API-echoed sends,
 * and view-once media are all unsupported here and must fall through
 * untouched.
 */

import { UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES } from './uazapi-api'

export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

const SUPPORTED_MIME_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp'])

const MIME_TO_FALLBACK_FILE_NAME: Record<SupportedImageMimeType, string> = {
  'image/jpeg': 'image.jpg',
  'image/png': 'image.png',
  'image/webp': 'image.webp',
}

export interface ParsedInboundImageMessage {
  /** Dedup key for `messages.message_id` — same field-selection logic as the other parsers. */
  providerMessageId: string
  /** `message.id`, the correct `id` param for `POST /message/download`. */
  providerDownloadId: string
  chatId: string
  sender: string
  senderName?: string
  /** ISO 8601 — the message's own timestamp when trustworthy, else a controlled "now" fallback. */
  occurredAt: string
  mimeType: SupportedImageMimeType
  /** Bytes, per UAZAPI's declared `content.fileLength` — NOT re-verified here (the caller must still validate the real downloaded size, never trust this alone). */
  fileSize: number
  width?: number
  height?: number
  /** Sanitized, trimmed, length-capped — from `message.text`, same convention as the document parser. */
  caption?: string
  /** No real file name is ever present in the payload — a stable, non-personal name derived from the MIME type. */
  fileName: string
}

// Same tolerances as the other parsers, duplicated intentionally
// rather than imported — this module stays reasoned-about in isolation.
const MIN_REASONABLE_TIMESTAMP_MS = Date.UTC(2009, 0, 1)
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

const MAX_CAPTION_LENGTH = 300
const MAX_REASONABLE_DIMENSION_PX = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
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

function sanitizeCaption(raw: string): string | undefined {
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim()
  if (cleaned.length === 0) return undefined
  return cleaned.slice(0, MAX_CAPTION_LENGTH)
}

/** A positive, finite, sane-magnitude pixel dimension, or `undefined` if the field is absent/malformed. Malformed is treated as absent, not as a reject — a bad width/height alone shouldn't sink an otherwise-valid image. */
function extractDimension(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  if (raw <= 0 || raw > MAX_REASONABLE_DIMENSION_PX) return undefined
  return raw
}

function isSupportedMimeType(value: unknown): value is SupportedImageMimeType {
  return typeof value === 'string' && SUPPORTED_MIME_TYPES.has(value)
}

/**
 * Parses a raw (`unknown`) UAZAPI webhook body into a
 * `ParsedInboundImageMessage`, or `null` when the event is outside
 * this stage's scope. Never trusts a field's presence or type without
 * checking it first — no unsafe casts on untrusted input.
 */
export function parseInboundImageMessage(payload: unknown): ParsedInboundImageMessage | null {
  if (!isRecord(payload)) return null
  if (payload.EventType !== 'messages') return null

  const message = payload.message
  if (!isRecord(message)) return null

  const chat = isRecord(payload.chat) ? payload.chat : undefined

  // Individual, inbound, human-sent only — same guards as the text and
  // document parsers.
  if (message.fromMe !== false) return null
  if (message.wasSentByApi !== false) return null
  if (message.isGroup !== false) return null
  if (chat && chat.wa_isGroup === true) return null

  if (message.messageType !== 'ImageMessage') return null
  if (message.type !== 'media') return null

  const content = message.content
  if (!isRecord(content)) return null

  // Privacy, checked first and explicitly: WhatsApp "view once" media
  // is never persisted, no matter what else is true about the event.
  if (content.viewOnce === true) return null

  if (!isSupportedMimeType(content.mimetype)) return null
  const mimeType = content.mimetype

  const fileLength = content.fileLength
  if (typeof fileLength !== 'number' || !Number.isFinite(fileLength)) return null
  if (fileLength < 1 || fileLength > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) return null

  const providerDownloadId = message.id
  if (typeof providerDownloadId !== 'string' || providerDownloadId.trim().length === 0) return null

  const providerMessageId = firstNonEmptyString([message.messageid, message.id])
  if (!providerMessageId) return null

  const chatId = message.chatid
  if (typeof chatId !== 'string' || chatId.trim().length === 0) return null

  const sender = message.sender
  if (typeof sender !== 'string' || sender.trim().length === 0) return null

  const senderName =
    typeof message.senderName === 'string' && message.senderName.trim().length > 0
      ? message.senderName.trim()
      : undefined

  const occurredAt = extractTimestamp(message.messageTimestamp)
  const width = extractDimension(content.width)
  const height = extractDimension(content.height)
  const caption = typeof message.text === 'string' ? sanitizeCaption(message.text) : undefined
  const fileName = MIME_TO_FALLBACK_FILE_NAME[mimeType]

  return {
    providerMessageId,
    providerDownloadId,
    chatId,
    sender,
    senderName,
    occurredAt,
    mimeType,
    fileSize: fileLength,
    width,
    height,
    caption,
    fileName,
  }
}
