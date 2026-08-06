import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyUazapiWebhookToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { parseInboundDocumentMessage } from '@/lib/whatsapp/uazapi-webhook-document-parser'
import { persistInboundDocumentMessage } from '@/lib/whatsapp/uazapi-webhook-document-persist'
import { parseInboundImageMessage } from '@/lib/whatsapp/uazapi-webhook-image-parser'
import { persistInboundImageMessage } from '@/lib/whatsapp/uazapi-webhook-image-persist'
import { parseInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-parser'
import { persistInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-persist'

// ============================================================
// UAZAPI inbound webhook — persists inbound text messages, PDF
// documents, and images (JPEG/PNG/WebP) on individual (non-group)
// chats. See docs/uazapi-webhook-progress.md for the full history and
// current scope.
//
// Scope for this stage: text (any content), PDF documents, and
// JPEG/PNG/WebP images. WhatsApp "view once" images are recognized but
// deliberately never persisted (privacy — see
// uazapi-webhook-image-parser.ts). Groups, fromMe, API-echoed sends,
// and other media types (audio/video/stickers, non-PDF documents,
// non-JPEG/PNG/WebP images) are all out of scope —
// parseInboundTextMessage, parseInboundDocumentMessage, and
// parseInboundImageMessage all return null for anything outside their
// own scope, and the route acks 200 {status:'ignored'} without
// persisting anything.
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
  if (parsedMessage) {
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

  // Not a text message in scope — try the PDF document path next.
  const parsedDocument = parseInboundDocumentMessage(parsed)
  if (parsedDocument) {
    let instanceToken: string
    try {
      instanceToken = await resolveInstanceToken(config.id)
    } catch {
      console.error('[uazapi/webhook:document-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: 'token_unavailable',
      })
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    const documentResult = await persistInboundDocumentMessage({
      db: supabaseAdmin(),
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      instanceToken,
      parsed: parsedDocument,
    })
    instanceToken = ''

    if (documentResult.outcome === 'error') {
      // No file name/phone/contact name/message id/storage path/URL/
      // base64/token/mediaKey/hashes — only a small, fixed internal code.
      console.error('[uazapi/webhook:document-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: documentResult.code,
      })
      // 5xx (not 200), same reasoning as the text path — a real failure
      // must never be acked as success.
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    console.log('[uazapi/webhook:document-persist]', documentResult.outcome, {
      instanceId: maskInstanceId(instanceId),
    })

    return NextResponse.json({ status: documentResult.outcome, type: 'document' }, { status: 200 })
  }

  // Not a document either — try the image path. `viewOnce` media,
  // groups, fromMe, API echoes, and unsupported MIME types all make
  // parseInboundImageMessage return null, falling through to
  // 'ignored' below exactly like the text/document branches.
  const parsedImage = parseInboundImageMessage(parsed)
  if (parsedImage) {
    let instanceToken: string
    try {
      instanceToken = await resolveInstanceToken(config.id)
    } catch {
      console.error('[uazapi/webhook:image-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: 'token_unavailable',
      })
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    const imageResult = await persistInboundImageMessage({
      db: supabaseAdmin(),
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      instanceToken,
      parsed: parsedImage,
    })
    instanceToken = ''

    if (imageResult.outcome === 'error') {
      // No caption/phone/contact name/message id/storage path/URL/
      // base64/token/mediaKey/hashes — only a small, fixed internal code.
      console.error('[uazapi/webhook:image-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: imageResult.code,
      })
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    console.log('[uazapi/webhook:image-persist]', imageResult.outcome, {
      instanceId: maskInstanceId(instanceId),
    })

    return NextResponse.json({ status: imageResult.outcome, type: 'image' }, { status: 200 })
  }

  console.log('[uazapi/webhook:persist] ignored', {
    instanceId: maskInstanceId(instanceId),
  })
  return NextResponse.json({ status: 'ignored' }, { status: 200 })
}

/** Fetches and decrypts the instance's UAZAPI token — shared by the document and image persistence paths (both need to call `POST /message/download`). Throws on any failure; callers map that to a 503 without leaking DB/decrypt detail. */
async function resolveInstanceToken(configId: string): Promise<string> {
  const { data: tokenRow, error: tokenError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('uazapi_instance_token')
    .eq('id', configId)
    .maybeSingle()

  if (tokenError || !tokenRow?.uazapi_instance_token) {
    throw new Error('token_unavailable')
  }
  return decrypt(tokenRow.uazapi_instance_token)
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
