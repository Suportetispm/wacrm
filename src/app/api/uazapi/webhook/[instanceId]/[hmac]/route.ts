import { after, NextResponse } from 'next/server'
import { isAccountActive } from '@/lib/accounts/active'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyUazapiWebhookToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { extractIndividualChatId, syncContactWhatsAppAvatar } from '@/lib/whatsapp/contact-avatar-sync'
import { parseInboundAudioMessage } from '@/lib/whatsapp/uazapi-webhook-audio-parser'
import { persistInboundAudioMessage } from '@/lib/whatsapp/uazapi-webhook-audio-persist'
import { parseInboundDocumentMessage } from '@/lib/whatsapp/uazapi-webhook-document-parser'
import { persistInboundDocumentMessage } from '@/lib/whatsapp/uazapi-webhook-document-persist'
import { parseInboundImageMessage } from '@/lib/whatsapp/uazapi-webhook-image-parser'
import { persistInboundImageMessage } from '@/lib/whatsapp/uazapi-webhook-image-persist'
import { parseInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-parser'
import { persistInboundTextMessage } from '@/lib/whatsapp/uazapi-webhook-persist'
import { wasSkippedForUnresolvedLid } from '@/lib/whatsapp/uazapi-webhook-identity'

// ============================================================
// UAZAPI inbound webhook — persists inbound text messages, PDF
// documents, images (JPEG/PNG/WebP), and audio / voice notes (stored as
// MP3) on individual (non-group) chats. See
// docs/uazapi-webhook-progress.md for the full history and current
// scope.
//
// Scope for this stage: text (any content), PDF documents,
// JPEG/PNG/WebP images, and audio (AudioMessage — voice notes and
// audio files). WhatsApp "view once" images/audio are recognized but
// deliberately never persisted (privacy — see the image/audio
// parsers). Groups, fromMe, API-echoed sends, and other media types
// (video/stickers, non-PDF documents, non-JPEG/PNG/WebP images) are
// all out of scope — every parser returns null for anything outside
// its own scope, and the route acks 200 {status:'ignored'} without
// persisting anything. Audio is never dispatched to Flows (their
// inbound media model has no audio type).
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

  // Empresa desativada (accounts.is_active = false — ver
  // 047_platform_account_management.sql): mesma checagem já aplicada
  // ao webhook Meta (src/app/api/whatsapp/webhook/route.ts) — ack 200
  // pra UAZAPI não entrar em retry, mas nada é lido/persistido daqui
  // pra baixo (sem contato/conversa/mensagem, sem automação/flow/IA).
  // Roda antes de ler o corpo — uma conta inativa não deve nem ter seu
  // payload parseado.
  if (!(await isAccountActive(supabaseAdmin(), config.account_id))) {
    console.warn('[uazapi/webhook:capture] account is inactive — dropping inbound event', {
      instanceId: maskInstanceId(instanceId),
    })
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
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
      // ETAPA 078B: resolved above from instanceId + HMAC — never from the payload.
      whatsappConfigId: config.id,
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

    // Flow dispatch — only for a genuinely new message ('persisted',
    // never 'duplicate' — a UAZAPI retry must never re-enter/re-advance
    // a run a second time for the same event) AND only when the
    // post-RPC routingState was actually confirmed (see RoutingState's
    // docstring in uazapi-webhook-persist.ts: `null` means "unknown",
    // never "unrouted" — dispatching on an unconfirmed state could
    // start a Flow on a conversation that's actually still routed/
    // assigned). The message is already safely persisted either way —
    // a missing routingState only skips the Flow side effect, never the
    // 200 response below. dispatchInboundToFlows never throws (its own
    // internal try/catch), but this is wrapped defensively anyway —
    // same convention already used for ensureUazapiWebhookRegistered in
    // the connect/status routes. Never affects the response below, and
    // never logs message content/tokens/payloads.
    if (result.outcome === 'persisted' && result.routingState) {
      try {
        await dispatchInboundToFlows({
          accountId: config.account_id,
          userId: config.user_id,
          contactId: result.contactId,
          conversationId: result.conversationId,
          queueId: result.routingState.queueId,
          assignedAgentId: result.routingState.assignedAgentId,
          message: {
            kind: 'text',
            text: parsedMessage.text,
            meta_message_id: parsedMessage.externalMessageId,
          },
          isFirstInboundMessage: result.isFirstInboundMessage,
        })
      } catch (err) {
        console.error(
          '[uazapi/webhook:flows] dispatchInboundToFlows threw unexpectedly:',
          err instanceof Error ? err.name : 'UnknownError',
        )
      }
    }

    // Automations (runAutomationsForTrigger) are intentionally NOT
    // connected here in this phase — the priority is UAZAPI→Flows for
    // sector triage. Wiring automations would be the same shape as
    // above, at the same point, if/when decided later.

    if (result.outcome === 'persisted') {
      scheduleContactAvatarSync(parsed, config.account_id, result.contactId, config.id)
    }

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
      // ETAPA 078B: resolved above from instanceId + HMAC — never from the payload.
      whatsappConfigId: config.id,
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

    // Flow dispatch — only for a genuinely new message ('persisted', not
    // 'duplicate') AND only when the post-RPC routing state was actually
    // confirmed (see RoutingState's docstring: `null` means "unknown",
    // never "unrouted" — starting a Flow on an unconfirmed state could
    // re-trigger triage on a conversation that's actually still routed/
    // assigned). isFirstInboundMessage is hardcoded false: media must
    // never satisfy first_inbound_message (engine.ts's findEntryFlow
    // already enforces this too — belt and suspenders, never trust a
    // single layer for this).
    if (documentResult.outcome === 'persisted' && documentResult.routingState) {
      try {
        await dispatchInboundToFlows({
          accountId: config.account_id,
          userId: config.user_id,
          contactId: documentResult.contactId,
          conversationId: documentResult.conversationId,
          queueId: documentResult.routingState.queueId,
          assignedAgentId: documentResult.routingState.assignedAgentId,
          message: {
            kind: 'media',
            media_type: 'document',
            meta_message_id: parsedDocument.providerMessageId,
          },
          isFirstInboundMessage: false,
        })
      } catch (err) {
        console.error(
          '[uazapi/webhook:flows] dispatchInboundToFlows threw unexpectedly (document):',
          err instanceof Error ? err.name : 'UnknownError',
        )
      }
    }

    if (documentResult.outcome === 'persisted') {
      scheduleContactAvatarSync(parsed, config.account_id, documentResult.contactId, config.id)
    }

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
      // ETAPA 078B: resolved above from instanceId + HMAC — never from the payload.
      whatsappConfigId: config.id,
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

    // Flow dispatch — same gating as the document path above: only
    // 'persisted' (never 'duplicate'), and only with a confirmed
    // post-RPC routingState.
    if (imageResult.outcome === 'persisted' && imageResult.routingState) {
      try {
        await dispatchInboundToFlows({
          accountId: config.account_id,
          userId: config.user_id,
          contactId: imageResult.contactId,
          conversationId: imageResult.conversationId,
          queueId: imageResult.routingState.queueId,
          assignedAgentId: imageResult.routingState.assignedAgentId,
          message: {
            kind: 'media',
            media_type: 'image',
            meta_message_id: parsedImage.providerMessageId,
          },
          isFirstInboundMessage: false,
        })
      } catch (err) {
        console.error(
          '[uazapi/webhook:flows] dispatchInboundToFlows threw unexpectedly (image):',
          err instanceof Error ? err.name : 'UnknownError',
        )
      }
    }

    if (imageResult.outcome === 'persisted') {
      scheduleContactAvatarSync(parsed, config.account_id, imageResult.contactId, config.id)
    }

    return NextResponse.json({ status: imageResult.outcome, type: 'image' }, { status: 200 })
  }

  // Not an image either — try the audio / voice-note path. Groups,
  // fromMe, API echoes, view-once audio and non-AudioMessage events all
  // make parseInboundAudioMessage return null, falling through to
  // 'ignored' below exactly like the other branches.
  const parsedAudio = parseInboundAudioMessage(parsed)
  if (parsedAudio) {
    let instanceToken: string
    try {
      instanceToken = await resolveInstanceToken(config.id)
    } catch {
      console.error('[uazapi/webhook:audio-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: 'token_unavailable',
      })
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    const audioResult = await persistInboundAudioMessage({
      db: supabaseAdmin(),
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      // ETAPA 078B: resolved above from instanceId + HMAC — never from the payload.
      whatsappConfigId: config.id,
      instanceToken,
      parsed: parsedAudio,
    })
    instanceToken = ''

    if (audioResult.outcome === 'error') {
      // No phone/contact name/message id/storage path/URL/token/mediaKey
      // — only a small, fixed internal code.
      console.error('[uazapi/webhook:audio-persist] persistence_failed', {
        instanceId: maskInstanceId(instanceId),
        code: audioResult.code,
      })
      return NextResponse.json({ error: 'persistence_failed' }, { status: 503 })
    }

    console.log('[uazapi/webhook:audio-persist]', audioResult.outcome, {
      instanceId: maskInstanceId(instanceId),
    })

    // Deliberately NO Flow dispatch for audio — see the header comment.
    if (audioResult.outcome === 'persisted') {
      scheduleContactAvatarSync(parsed, config.account_id, audioResult.contactId, config.id)
    }

    return NextResponse.json({ status: audioResult.outcome, type: 'audio' }, { status: 200 })
  }

  // Distinguishes the specific, identifiable "LID only, no phone
  // could be resolved" reason from every other out-of-scope reason
  // this event could have fallen through for (wrong event type,
  // group, fromMe, unsupported content type, etc). No phone/name/
  // payload/token — see wasSkippedForUnresolvedLid's own docstring.
  if (wasSkippedForUnresolvedLid(parsed)) {
    console.warn('[uazapi/webhook:capture] inbound skipped: canonical phone could not be resolved', {
      instanceId: maskInstanceId(instanceId),
      lid_detected: true,
    })
  }

  console.log('[uazapi/webhook:persist] ignored', {
    instanceId: maskInstanceId(instanceId),
  })
  return NextResponse.json({ status: 'ignored' }, { status: 200 })
}

/**
 * Schedules the contact's WhatsApp profile-picture sync to run AFTER the
 * response is sent (`after()`, supported by `next start`), so it never
 * delays or changes the webhook's answer. Individual inbound chats only
 * (`extractIndividualChatId` returns null for groups/fromMe/echoes).
 * The token comes from the SAME HMAC-validated connection (`configId`),
 * and is only resolved if a query is actually due. Every failure —
 * including `after()` itself being unavailable — is swallowed.
 */
function scheduleContactAvatarSync(
  payload: unknown,
  accountId: string,
  contactId: string,
  configId: string,
): void {
  const chatId = extractIndividualChatId(payload)
  if (!chatId) return
  try {
    after(async () => {
      try {
        await syncContactWhatsAppAvatar({
          db: supabaseAdmin(),
          accountId,
          contactId,
          chatId,
          getInstanceToken: () => resolveInstanceToken(configId),
        })
      } catch {
        // Never propagates — the message was already handled.
      }
    })
  } catch {
    console.error('[contact-avatar-sync] schedule_failed')
  }
}

/** Fetches and decrypts the instance's UAZAPI token — shared by the document, image and audio persistence paths (all need to call `POST /message/download`). Throws on any failure; callers map that to a 503 without leaking DB/decrypt detail. */
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
