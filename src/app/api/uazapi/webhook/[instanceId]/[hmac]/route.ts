import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { downloadMessageMedia, estimateBase64DecodedBytes, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'
import { verifyUazapiWebhookToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { parseInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-parser'
import { persistInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-persist'

// ============================================================
// UAZAPI inbound webhook — persists inbound text messages on
// individual (non-group) chats. See docs/uazapi-webhook-progress.md
// for the full history and current scope.
//
// Scope for this stage: text only. Media, groups, fromMe, API-echoed
// sends, and non-text content types are all out of scope —
// parseInboundTextMessage returns null for all of it, and the route
// acks 200 {status:'ignored'} without persisting anything.
//
// ETAPA 8.3 FASE 1 — TEMPORARY shape-discovery diagnostic re-added
// below (see `logIgnoredMessageShape`) to map UAZAPI's real inbound
// document-message payload before writing a parser for it. Structural
// only (field NAMES and value TYPES, never field values — except the
// short messageType/type enum). Remove once the document shape is
// confirmed and the dedicated parser exists — see
// docs/uazapi-webhook-progress.md.
// ============================================================

// 256 KB is generous for a single WhatsApp message event's metadata
// envelope — a legitimate payload this large would already be unusual
// for what we expect to capture here.
const MAX_BODY_BYTES = 256 * 1024

const HMAC_HEX_PATTERN = /^[0-9a-f]{64}$/i

function maskInstanceId(id: string): string {
  if (id.length <= 6) return '***'
  return `${id.slice(0, 3)}…${id.slice(-2)}`
}

// Local to this route — deliberately NOT imported from the parser
// module (etapa 8.3 rule: keep this temporary diagnostic isolated
// from the text-parsing code path it's investigating around).
function isRecordLocal(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/** Key name → value TYPE only (never the value). One flat level, no
 * recursion into nested objects — a nested `describeFields` call
 * previously produced objects 3-4 levels deep, which `console.log`'s
 * default inspect depth (2) silently collapsed to `[Array]`/`[Object]`,
 * hiding exactly the fields (inside `message.content`) this diagnostic
 * exists to find. Flat objects/arrays of strings or booleans, like
 * this returns, never hit that depth limit. */
function describeFieldTypes(record: Record<string, unknown>): Record<string, string> {
  const types: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    types[key] = fieldType(value)
  }
  return types
}

/** Keyword match over collected key names only — never over values. */
function anyKeyMatches(keys: string[], needles: string[]): boolean {
  const lowered = keys.map((k) => k.toLowerCase())
  return needles.some((needle) => lowered.some((k) => k.includes(needle)))
}

/** Presence-only flags for the media metadata fields this stage needs
 * to locate — computed from `message.content`'s key NAMES only, never
 * its values. */
function contentPresenceFlags(contentKeys: string[]) {
  return {
    hasFileName: anyKeyMatches(contentKeys, ['filename', 'file_name']),
    hasMimeType: anyKeyMatches(contentKeys, ['mime']),
    hasFileSize: anyKeyMatches(contentKeys, ['filesize', 'file_size', 'size', 'length']),
    hasUrl: anyKeyMatches(contentKeys, ['url']),
    hasMediaId: anyKeyMatches(contentKeys, ['mediaid', 'media_id']),
    hasDirectPath: anyKeyMatches(contentKeys, ['directpath', 'direct_path']),
    hasCaption: anyKeyMatches(contentKeys, ['caption']),
    hasThumbnail: anyKeyMatches(contentKeys, ['thumbnail', 'thumb']),
  }
}

// TEMPORARY (etapa 8.3 FASE 1) — logs field NAMES and value TYPES only
// for an inbound event this stage doesn't parse yet, so the real
// document-message shape (specifically `message.content`, where a
// media message's metadata lives) can be mapped without guessing.
// Never logs phone, name, message content, caption, full URL, base64,
// token, HMAC, instance token, or full ids — only key names, value
// TYPES, and boolean presence flags.
function logIgnoredMessageShape(parsed: unknown, instanceId: string): void {
  if (!isRecordLocal(parsed) || parsed.EventType !== 'messages') return
  const message = isRecordLocal(parsed.message) ? parsed.message : undefined
  if (!message) return

  const topKeys = Object.keys(parsed).sort()
  const messageKeys = Object.keys(message).sort()
  const messageFieldTypes = describeFieldTypes(message)

  const content = message.content
  const contentKeys = isRecordLocal(content) ? Object.keys(content).sort() : []
  const contentFieldTypes = isRecordLocal(content) ? describeFieldTypes(content) : undefined

  console.log('[uazapi/webhook:shape-discovery]', {
    instanceId: maskInstanceId(instanceId),
    topKeys,
    messageType: message.messageType,
    type: message.type,
    messageKeys,
    messageFieldTypes,
    contentKeys,
    contentFieldTypes,
    contentPresence: contentPresenceFlags(contentKeys),
  })
}

// ============================================================
// TEMPORARY (ETAPA 8.3 FASE 2.8) — one-shot, dev-only real-call test
// of the official `downloadMessageMedia` wrapper (uazapi-api.ts)
// against the next real DocumentMessage this webhook receives. The
// endpoint contract is confirmed (`POST /message/download`, body
// field `id` — see docs/uazapi-webhook-progress.md); this stage only
// verifies the wrapper itself returns a real, decodable file, so no
// more candidate-guessing (no `messageid`, `chatid`, hand-rolled URL,
// mediaKey, directPath, or hashes). Disabled outright in production,
// fires at most once per server process, and never touches the
// definitive text parser/persist path. Logs only structural/presence
// data — never the token, id, url, base64, or file bytes. Remove this
// whole block once confirmed and a real document parser/persist path
// exists.
// ============================================================

let documentDownloadProbeFired = false

function maskId(id: string): string {
  if (id.length <= 8) return '*'.repeat(id.length)
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

/** Strips URLs and long token/id/hash-looking runs out of a
 * server-supplied error message before it's logged — the text itself
 * is useful for debugging, but may echo back request values that
 * shouldn't appear in logs verbatim. */
function sanitizeValidationMessage(raw: string): string {
  let s = raw.slice(0, 500)
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
  s = s.replace(/[A-Za-z0-9+/_=-]{20,}/g, '<redacted>')
  s = s.replace(/\+?\d{8,}/g, '<redacted>')
  return s.slice(0, 200)
}

/** Keeps only characters valid in a MIME type, truncated — the raw
 * value is server-supplied and never trusted verbatim into a log line. */
function sanitizeMimeType(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9/.+-]/g, '').slice(0, 100)
}

type FileSignature = 'pdf' | 'zip_or_office' | 'image' | 'unknown'

/** Classifies a file by its first few bytes only. The bytes themselves
 * are never logged — only this one classification label. */
function classifyFileSignature(bytes: Buffer): FileSignature {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf'
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip_or_office'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image'
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image'
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image'
  return 'unknown'
}

/**
 * Decodes only the first 12 base64 characters (→ 9 decoded bytes) —
 * comfortably enough for every signature checked above, and nowhere
 * near the full payload. Callers must discard the result immediately
 * after classification; it is never logged, saved, or forwarded.
 */
function decodeLeadingBytesForSignatureCheck(base64: string): Buffer {
  return Buffer.from(base64.slice(0, 12), 'base64')
}

/**
 * Real call to the official `downloadMessageMedia` wrapper against
 * the next inbound DocumentMessage, using exactly `{ id: message.id,
 * returnBase64: true }` per the confirmed docs. Fires once per
 * process. The decoded file content is discarded immediately after
 * the signature check — never saved to disk, forwarded, or logged.
 */
async function probeDocumentDownloadOnce(
  message: Record<string, unknown>,
  instanceId: string,
  configId: string,
): Promise<void> {
  if (process.env.NODE_ENV === 'production') return
  if (documentDownloadProbeFired) return
  if (message.messageType !== 'DocumentMessage') return
  documentDownloadProbeFired = true // claim the single run before any await

  const id = message.id
  if (typeof id !== 'string') {
    console.log('[uazapi/webhook:TEMP-download-probe] message.id is not a string, skipping')
    return
  }
  const maskedId = maskId(id)

  let instanceToken: string | undefined
  try {
    const { data: row, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('uazapi_instance_token')
      .eq('id', configId)
      .maybeSingle()

    if (error || !row?.uazapi_instance_token) {
      console.log('[uazapi/webhook:TEMP-download-probe] no encrypted token found for instance')
      return
    }
    instanceToken = decrypt(row.uazapi_instance_token)

    const result = await downloadMessageMedia({ instanceToken, id, returnBase64: true })

    const log: Record<string, unknown> = {
      instanceId: maskInstanceId(instanceId),
      id: maskedId,
      callCompleted: true,
      hasFileUrl: Boolean(result.fileUrl),
      hasMimetype: Boolean(result.mimetype),
      hasBase64Data: Boolean(result.base64Data),
      hasTranscription: Boolean(result.transcription),
      mimetype: result.mimetype ? sanitizeMimeType(result.mimetype) : undefined,
    }

    if (result.base64Data) {
      log.decodedByteSize = estimateBase64DecodedBytes(result.base64Data)
      log.signature = classifyFileSignature(decodeLeadingBytesForSignatureCheck(result.base64Data))
    }

    console.log('[uazapi/webhook:TEMP-download-probe] result', log)
  } catch (err) {
    const base = { instanceId: maskInstanceId(instanceId), id: maskedId, callCompleted: false }
    if (err instanceof UazapiHttpError) {
      console.log('[uazapi/webhook:TEMP-download-probe] error', {
        ...base,
        errorClass: err.name,
        status: err.status,
        message: sanitizeValidationMessage(err.message),
      })
    } else {
      console.log('[uazapi/webhook:TEMP-download-probe] error', {
        ...base,
        errorClass: err instanceof Error ? err.name : 'unknown',
      })
    }
  } finally {
    instanceToken = undefined
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ instanceId: string; hmac: string }> },
) {
  const { instanceId, hmac } = await params

  if (!instanceId) {
    return NextResponse.json({ error: 'Missing instance id' }, { status: 400 })
  }

  // Format check before the (more expensive, and secret-dependent)
  // constant-time compare — a malformed token can never be valid.
  if (!HMAC_HEX_PATTERN.test(hmac)) {
    console.warn('[uazapi/webhook:capture] malformed token format for instance', maskInstanceId(instanceId))
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  if (!verifyUazapiWebhookToken(instanceId, hmac)) {
    console.warn('[uazapi/webhook:capture] token mismatch for instance', maskInstanceId(instanceId))
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // Resolve the instance to a real, uazapi-provider account BEFORE
  // touching the body at all — an authenticated-but-unknown instance
  // id still isn't worth reading or logging anything for.
  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('uazapi_instance_id', instanceId)
    .eq('provider', 'uazapi')
    .maybeSingle()

  if (configError) {
    console.error('[uazapi/webhook:capture] error resolving instance config')
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!config) {
    console.warn('[uazapi/webhook:capture] no whatsapp_config for instance', maskInstanceId(instanceId))
    return NextResponse.json({ error: 'Unknown instance' }, { status: 404 })
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'Expected application/json' }, { status: 415 })
  }

  // Reject on the declared Content-Length first (cheap); the loop
  // below ALSO enforces the same cap while actually reading the
  // stream, so a missing or understated header can't let an
  // oversized body through.
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const bodyResult = await readBodyWithLimit(request, MAX_BODY_BYTES)
  if (!bodyResult.ok) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyResult.text)
  } catch {
    // Never log the raw text that failed to parse.
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Everything out of this stage's scope (media, groups, fromMe, API
  // echoes, non-text types) makes parseInboundTextMessage return null,
  // leaving this branch an intentional no-op.
  const parsedMessage = parseInboundTextMessage(parsed)
  if (!parsedMessage) {
    logIgnoredMessageShape(parsed, instanceId)
    if (isRecordLocal(parsed) && isRecordLocal(parsed.message)) {
      await probeDocumentDownloadOnce(parsed.message, instanceId, config.id)
    }
    console.log('[uazapi/webhook:persist] ignored', {
      instanceId: maskInstanceId(instanceId),
    })
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const result = await persistInboundTextMessage({
    db: supabaseAdmin(),
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    parsed: parsedMessage,
  })

  if (result.outcome === 'error') {
    // No phone/name/text/external id/raw DB error — only a small,
    // fixed internal code, safe to keep in server logs.
    console.error('[uazapi/webhook:persist] persistence_failed', {
      instanceId: maskInstanceId(instanceId),
      code: result.code,
    })
    // 5xx (not 200) so UAZAPI's own documented retry mechanism kicks
    // in — acking 200 on a real failure would silently lose the
    // message with no way to recover it. No DB detail in the body.
    return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
  }

  console.log('[uazapi/webhook:persist]', result.outcome, {
    instanceId: maskInstanceId(instanceId),
  })

  return NextResponse.json({ status: result.outcome }, { status: 200 })
}

async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = request.body?.getReader()
  if (!reader) return { ok: true, text: '' }

  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      return { ok: false }
    }
    chunks.push(value)
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { ok: true, text: buffer.toString('utf-8') }
}
