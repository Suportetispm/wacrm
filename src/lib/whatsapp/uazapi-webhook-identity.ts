/**
 * Shared WhatsApp/UAZAPI identity resolution — no I/O, no DB access,
 * fully unit-testable. Used by all three inbound persist paths
 * (text/image/document) so they agree on exactly one rule for turning
 * a UAZAPI event's sender/chat fields into a canonical phone number.
 *
 * Root cause this replaces: the previous per-path logic
 * (`stripJidSuffix` + `normalizeCandidatePhone`, duplicated three
 * times) stripped a JID's `@...` suffix and accepted whatever digits
 * were left as a phone number, with no regard for WHICH suffix it
 * was. A WhatsApp LID (`@lid` — an internal, non-phone identifier)
 * is also all-digits and can fall inside a plausible phone-length
 * range, so it silently passed the same check a real phone number
 * would — producing a second `contacts` row for the same real person
 * (issue: "Supermassa Comercial" duplicated in the Inbox).
 *
 * This module fixes that by classifying the suffix BEFORE stripping
 * it, so a LID can never be mistaken for a phone number no matter how
 * plausible its digit count looks.
 */

export type UazapiJidKind = 'phone' | 'lid' | 'unknown'

export interface ClassifiedIdentifier {
  kind: UazapiJidKind
  /** Digits-only portion before the '@' (or the whole string when there's no '@'). Only meaningful as a phone number when `kind === 'phone'` — callers must check `kind` first. */
  digits: string
}

const PHONE_JID_SUFFIX = '@s.whatsapp.net'
const LID_JID_SUFFIX = '@lid'

const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15

/**
 * Classifies a raw UAZAPI sender/chat identifier by its JID suffix.
 * A bare digit-ish string with no `@` at all (e.g. `chat.phone`,
 * `message.sender_pn`) is treated as already phone-shaped, not as a
 * JID — those fields are never suffixed in UAZAPI's envelope.
 *
 * `@s.whatsapp.net` → `'phone'` (a real, phone-backed WhatsApp JID).
 * `@lid` → `'lid'` (WhatsApp's internal identifier — never a phone).
 * Anything else (a group JID, a future/unrecognized suffix) →
 * `'unknown'` — never assumed to be a phone just because it's numeric.
 */
export function classifyIdentifier(raw: string): ClassifiedIdentifier {
  const at = raw.indexOf('@')
  if (at < 0) {
    return { kind: 'phone', digits: raw.replace(/\D/g, '') }
  }
  const suffix = raw.slice(at).toLowerCase()
  const digits = raw.slice(0, at).replace(/\D/g, '')
  if (suffix === PHONE_JID_SUFFIX) return { kind: 'phone', digits }
  if (suffix === LID_JID_SUFFIX) return { kind: 'lid', digits }
  return { kind: 'unknown', digits }
}

function isPlausiblePhoneDigits(digits: string): boolean {
  return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS
}

export interface CanonicalPhoneResolution {
  /** The resolved canonical phone (digits only), or `null` when no candidate qualified. */
  phone: string | null
  /** True when at least one candidate examined along the way was recognized as a LID — surfaced so callers can log a safe, non-identifying diagnostic signal without ever writing the LID's digits anywhere. */
  lidDetected: boolean
}

/**
 * Resolves the single canonical phone number for an inbound UAZAPI
 * event from an ordered list of candidate raw values (highest
 * priority first). Only a candidate classified as `'phone'` with a
 * plausible digit length (7-15) can ever be returned; a `'lid'` or
 * `'unknown'` candidate is skipped over — never falls back to
 * treating its digits as a phone number.
 *
 * Non-string / empty / whitespace-only candidates are skipped
 * silently (callers pass optional fields straight through without
 * pre-filtering).
 */
export function resolveCanonicalPhone(candidates: unknown[]): CanonicalPhoneResolution {
  let lidDetected = false

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (!trimmed) continue

    const classified = classifyIdentifier(trimmed)
    if (classified.kind === 'lid') {
      lidDetected = true
      continue
    }
    if (classified.kind !== 'phone') continue
    if (!isPlausiblePhoneDigits(classified.digits)) continue

    return { phone: classified.digits, lidDetected }
  }

  return { phone: null, lidDetected }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Diagnostic-only check for the webhook route's final "nothing
 * matched" fallback: true when a raw UAZAPI event carries a `message`
 * whose sender/chat identity resolves to "LID seen, no phone" — i.e.
 * the specific, identifiable reason a message can't be attributed to
 * any contact, as opposed to any other out-of-scope reason (wrong
 * event type, group, `fromMe`, unsupported content). Reads the same
 * five candidate fields every persist path already reads; never reads
 * or returns anything else from the payload (no token, no raw body).
 */
export function wasSkippedForUnresolvedLid(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const message = isRecord(payload.message) ? payload.message : undefined
  if (!message) return false
  const chat = isRecord(payload.chat) ? payload.chat : undefined

  const { phone, lidDetected } = resolveCanonicalPhone([
    message.sender_pn,
    message.sender,
    chat?.phone,
    message.chatid,
    chat?.wa_chatid,
  ])

  return phone === null && lidDetected
}
