/**
 * Pure parser for a UAZAPI `messages` webhook event carrying an
 * inbound PDF document — no I/O, no DB access, fully unit-testable
 * with fixture payloads. Mirrors `uazapi-webhook-parser.ts`'s
 * conventions (same envelope shape, same accept-only-in-scope
 * philosophy) but is deliberately self-contained: nothing is imported
 * from the text parser, so this module can be reasoned about (and
 * removed, if the document flow is ever abandoned) independently.
 *
 * Confirmed real envelope (FASE 2.8, a live DocumentMessage capture):
 *   { EventType, chat, chatSource, message, instanceName, owner, BaseUrl, token }
 * with `message.content` (the media metadata) shaped as:
 *   { URL, mimetype, fileSHA256, fileLength, pageCount, mediaKey,
 *     fileName, fileEncSHA256, directPath, mediaKeyTimestamp,
 *     thumbnailDirectPath, thumbnailSHA256, thumbnailEncSHA256,
 *     JPEGThumbnail, contextInfo, thumbnailHeight, thumbnailWidth }
 *
 * This module only ever reads `EventType`, `chat` (for the
 * `wa_isGroup` defense-in-depth check), and a fixed subset of
 * `message`/`message.content`. It never reads — and therefore can
 * never accidentally leak into its return value — `URL`, `mediaKey`,
 * `directPath`, `fileSHA256`, `fileEncSHA256`, `thumbnailDirectPath`,
 * `thumbnailSHA256`, `thumbnailEncSHA256`, `JPEGThumbnail`,
 * `instanceName`, `owner`, `BaseUrl`, or `token`.
 *
 * Scope for this stage: PDF only (`content.mimetype ===
 * 'application/pdf'` exactly), individual chats only, inbound only.
 * Returns `null` for anything else — other document MIME types,
 * images/audio/video, groups, `fromMe`, and API-echoed sends are all
 * unsupported here and must fall through untouched.
 */

import { UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES } from './uazapi-api'

export interface ParsedInboundDocumentMessage {
  /** Dedup key for `messages.message_id` — same field-selection logic as the text parser's `externalMessageId`. Deliberately NOT assumed equal to `providerDownloadId`. */
  providerMessageId: string
  /** `message.id`, confirmed (FASE 2.8) as the correct `id` param for `POST /message/download`. */
  providerDownloadId: string
  chatId: string
  sender: string
  senderName?: string
  /** ISO 8601 — the message's own timestamp when trustworthy, else a controlled "now" fallback. */
  occurredAt: string
  /** Sanitized — no control chars, no path components, length-capped. */
  fileName: string
  mimeType: string
  /** Bytes, per UAZAPI's declared `content.fileLength` — NOT re-verified here (the caller must still validate the real downloaded size, never trust this alone). */
  fileSize: number
  pageCount?: number
  /** Sanitized, trimmed, length-capped. */
  caption?: string
}

// Same tolerances as the text parser, duplicated intentionally rather
// than imported — this module stays reasoned-about in isolation.
const MIN_REASONABLE_TIMESTAMP_MS = Date.UTC(2009, 0, 1)
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

const MAX_FILE_NAME_LENGTH = 150
const MAX_CAPTION_LENGTH = 300
const FALLBACK_FILE_NAME = 'document.pdf'

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

/**
 * Strips control characters, drops any path/directory component
 * (keeps only the final segment), caps length, and guarantees a
 * `.pdf` extension (this parser only ever accepts `application/pdf`,
 * so the extension is always known-correct, never trusted from the
 * untrusted input string itself beyond cosmetic display). Never used
 * to build a storage path — display/metadata only.
 */
function sanitizeFileName(raw: string): string {
  let name = raw.replace(/[\x00-\x1F\x7F]/g, '')
  name = name.split(/[/\\]/).pop() ?? ''
  name = name.trim()
  if (name.length === 0) return FALLBACK_FILE_NAME

  if (name.length > MAX_FILE_NAME_LENGTH) {
    name = name.slice(0, MAX_FILE_NAME_LENGTH)
  }
  if (!/\.pdf$/i.test(name)) {
    name = `${name}.pdf`
  }
  return name
}

function sanitizeCaption(raw: string): string | undefined {
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim()
  if (cleaned.length === 0) return undefined
  return cleaned.slice(0, MAX_CAPTION_LENGTH)
}

/**
 * Parses a raw (`unknown`) UAZAPI webhook body into a
 * `ParsedInboundDocumentMessage`, or `null` when the event is outside
 * this stage's scope. Never trusts a field's presence or type without
 * checking it first — no unsafe casts on untrusted input.
 */
export function parseInboundDocumentMessage(payload: unknown): ParsedInboundDocumentMessage | null {
  if (!isRecord(payload)) return null
  if (payload.EventType !== 'messages') return null

  const message = payload.message
  if (!isRecord(message)) return null

  const chat = isRecord(payload.chat) ? payload.chat : undefined

  // Individual, inbound, human-sent only — same guards as the text parser.
  if (message.fromMe !== false) return null
  if (message.wasSentByApi !== false) return null
  if (message.isGroup !== false) return null
  if (chat && chat.wa_isGroup === true) return null

  if (message.messageType !== 'DocumentMessage') return null
  if (message.type !== 'media') return null

  const content = message.content
  if (!isRecord(content)) return null

  if (content.mimetype !== 'application/pdf') return null

  const fileLength = content.fileLength
  if (typeof fileLength !== 'number' || !Number.isFinite(fileLength)) return null
  if (fileLength <= 0 || fileLength > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) return null

  const rawFileName = content.fileName
  if (typeof rawFileName !== 'string' || rawFileName.trim().length === 0) return null

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
  const fileName = sanitizeFileName(rawFileName)

  const pageCount =
    typeof content.pageCount === 'number' && Number.isFinite(content.pageCount) && content.pageCount >= 0
      ? content.pageCount
      : undefined

  const caption = typeof message.text === 'string' ? sanitizeCaption(message.text) : undefined

  return {
    providerMessageId,
    providerDownloadId,
    chatId,
    sender,
    senderName,
    occurredAt,
    fileName,
    mimeType: 'application/pdf',
    fileSize: fileLength,
    pageCount,
    caption,
  }
}
