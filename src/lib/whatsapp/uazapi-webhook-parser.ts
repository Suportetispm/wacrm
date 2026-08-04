/**
 * Pure parser for a UAZAPI `messages` webhook event — no I/O, no DB
 * access, fully unit-testable with fixture payloads.
 *
 * Confirmed real envelope (etapa 8.2C/8.2D), no `data` wrapper:
 *   { EventType, chat, chatSource, message, instanceName, owner, BaseUrl, token }
 *
 * This module only ever reads `EventType`, `chat`, and `message` — it
 * never touches `chatSource`, `instanceName`, `owner`, `BaseUrl`, or
 * `token` (the last is the instance's own auth token, echoed back by
 * UAZAPI inside the event body; reading it here would be one step
 * from accidentally logging it).
 *
 * Scope for this stage: text only, individual chats only, inbound
 * only. Returns `null` for anything else — images/audio/video/
 * documents/locations, groups, `fromMe`, and API-echoed sends are all
 * unsupported here and must fall through untouched.
 */

export interface ParsedInboundTextMessage {
  /** UAZAPI's own id for this message — the future DB `messages.message_id`. */
  externalMessageId: string
  /** Canonical digits-only phone, matching how `contacts.phone` is already stored by the Meta path (see src/app/api/whatsapp/webhook/route.ts). */
  phone: string
  name: string
  text: string
  /** ISO 8601 — the message's own timestamp when trustworthy, else a controlled "now" fallback. */
  occurredAt: string
}

const TEXT_MESSAGE_TYPES = new Set(['text', 'conversation', 'extendedTextMessage'])

// WhatsApp (and therefore UAZAPI) didn't exist before this — a
// timestamp older than this is not a real message time.
const MIN_REASONABLE_TIMESTAMP_MS = Date.UTC(2009, 0, 1)
// Tolerate ordinary clock skew between UAZAPI's server and ours.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/** Strips a WhatsApp JID suffix (`@s.whatsapp.net`, `@g.us`, ...), keeping only what's before `@`. */
function stripJidSuffix(value: string): string {
  const at = value.indexOf('@')
  return at >= 0 ? value.slice(0, at) : value
}

/** Digits-only, JID-stripped, length-sane phone — or null if nothing usable. */
function normalizeCandidatePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = stripJidSuffix(raw).replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return digits
}

function extractPhone(
  message: Record<string, unknown>,
  chat: Record<string, unknown> | undefined,
): string | null {
  const candidates = [
    message.sender_pn,
    message.sender,
    chat?.phone,
    message.chatid,
    chat?.wa_chatid,
  ]
  for (const candidate of candidates) {
    const phone = normalizeCandidatePhone(candidate)
    if (phone) return phone
  }
  return null
}

function extractName(
  message: Record<string, unknown>,
  chat: Record<string, unknown> | undefined,
  phone: string,
): string {
  return (
    firstNonEmptyString([
      message.senderName,
      chat?.lead_fullName,
      chat?.lead_name,
      chat?.wa_contactName,
      chat?.name,
    ]) ?? phone // safe fallback — never invents a personal name
  )
}

function isTextMessageType(message: Record<string, unknown>): boolean {
  const messageType = typeof message.messageType === 'string' ? message.messageType : undefined
  const type = typeof message.type === 'string' ? message.type : undefined
  if (messageType && TEXT_MESSAGE_TYPES.has(messageType)) return true
  if (type && TEXT_MESSAGE_TYPES.has(type)) return true
  return false
}

function extractTimestamp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Documented as milliseconds; a value too small to plausibly be a
    // ms timestamp is treated as seconds instead (defensive — some
    // WhatsApp integrations report seconds).
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (ms >= MIN_REASONABLE_TIMESTAMP_MS && ms <= Date.now() + MAX_FUTURE_SKEW_MS) {
      return new Date(ms).toISOString()
    }
  }
  // Controlled fallback only — never throws, never leaves occurredAt unset.
  return new Date().toISOString()
}

/**
 * Parses a raw (`unknown`) UAZAPI webhook body into a
 * `ParsedInboundTextMessage`, or `null` when the event is outside
 * this stage's scope (wrong event type, outbound/API/group message,
 * non-text content, or a payload that doesn't validate). Never trusts
 * a field's presence or type without checking it first — no unsafe
 * casts on untrusted input.
 */
export function parseInboundTextMessage(payload: unknown): ParsedInboundTextMessage | null {
  if (!isRecord(payload)) return null
  if (payload.EventType !== 'messages') return null

  const message = payload.message
  if (!isRecord(message)) return null

  const chat = isRecord(payload.chat) ? payload.chat : undefined

  // Individual, inbound, human-sent only.
  if (message.fromMe !== false) return null
  if (message.wasSentByApi !== false) return null
  if (message.isGroup !== false) return null
  // Defense in depth: `chat.wa_isGroup` is a second, independently
  // confirmed group indicator — reject if either says group.
  if (chat && chat.wa_isGroup === true) return null

  const externalMessageId = firstNonEmptyString([message.messageid, message.id])
  if (!externalMessageId) return null

  if (!isTextMessageType(message)) return null

  const text = message.text
  if (typeof text !== 'string' || text.trim().length === 0) return null

  const phone = extractPhone(message, chat)
  if (!phone) return null

  const name = extractName(message, chat, phone)
  const occurredAt = extractTimestamp(message.messageTimestamp)

  return { externalMessageId, phone, name, text, occurredAt }
}
