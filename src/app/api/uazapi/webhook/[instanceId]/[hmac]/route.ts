import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { verifyUazapiWebhookToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { sanitizeWebhookPayload } from '@/lib/whatsapp/uazapi-webhook-sanitizer'

// ============================================================
// TEMPORARY — UAZAPI webhook payload capture.
//
// This is NOT the persistence route. It exists only to safely learn
// the real shape of a UAZAPI webhook event before writing any
// contact/conversation/message logic — neither this project's code
// nor UAZAPI's own docs site (a JS-rendered SPA we could not extract
// a schema from) could confirm the payload format ahead of time.
// Nothing is persisted here beyond one structural log line: no
// contact, no conversation, no message, no media download, no
// automations/flows/AI/outbound-webhook dispatch.
//
// Remove this file (and uazapi-webhook-sanitizer.ts) once the real
// contract is confirmed and the persistence route replaces it.
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
    .select('id')
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

  const structure = sanitizeWebhookPayload(parsed)

  // The ONLY log line this route ever writes. No raw payload, no
  // parsed values, no headers object, no HMAC/token, no full instance
  // id — just shape/size metadata safe to keep in server logs.
  console.log('[uazapi/webhook:capture] payload captured', {
    instanceId: maskInstanceId(instanceId),
    contentType,
    bodyBytes: bodyResult.text.length,
    structure,
  })

  return NextResponse.json({ status: 'captured' }, { status: 200 })
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
