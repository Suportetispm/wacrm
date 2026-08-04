import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import { getWebhookConfiguration, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

/**
 * Sanitized bucket for an external UAZAPI error message — same
 * convention as `webhook/register/route.ts`. A small, fixed enum,
 * never the original text, so a log line can carry a diagnostic
 * signal without risking exposure of whatever the external body
 * actually contained.
 */
type ExternalErrorCode =
  | 'missing_token'
  | 'invalid_token'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_payload'
  | 'unknown_external_error'

/**
 * Classifies an external error message into an `ExternalErrorCode` by
 * keyword match only. `message` is lowercased and inspected in memory
 * for this single call and then discarded — it is never logged,
 * returned, or persisted anywhere; only the returned code is.
 */
function classifyExternalError(message: string | undefined): ExternalErrorCode {
  if (!message) return 'unknown_external_error'
  const lower = message.toLowerCase()

  if (lower.includes('missing') && lower.includes('token')) return 'missing_token'
  if (lower.includes('invalid') && lower.includes('token')) return 'invalid_token'
  if (lower.includes('forbidden')) return 'forbidden'
  if (lower.includes('unauthorized')) return 'unauthorized'
  if (
    lower.includes('invalid') &&
    (lower.includes('payload') || lower.includes('action') || lower.includes('body'))
  ) {
    return 'invalid_payload'
  }
  return 'unknown_external_error'
}

/**
 * GET /api/uazapi/webhook/status
 *
 * Read-only lookup of the caller's account's UAZAPI webhook
 * configuration — never mutates anything. Admin-only, matching
 * `webhook/register`. `instanceToken`/`accountId` are always resolved
 * server-side from the authenticated session, never accepted from the
 * client. The response is a fixed, sanitized shape — no URL, HMAC,
 * token, instance id, or raw external body ever leaves this route.
 */
export async function GET() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId } = ctx

  const config = await loadActiveWhatsAppConfig(supabase, accountId)
  if (!config || config.provider !== 'uazapi' || !config.instanceToken) {
    return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 400 })
  }

  try {
    const webhooks = await getWebhookConfiguration({ instanceToken: config.instanceToken })
    const current = webhooks[0]

    return NextResponse.json({
      configured: Boolean(current),
      enabled: current ? current.enabled : null,
      events: current ? current.events : [],
      hasUrl: current ? current.url.length > 0 : false,
    })
  } catch (err) {
    // Same redaction rule as webhook/register: never surface err.message
    // or the external body — only a sanitized code, the external HTTP
    // status, when available, and no instance id (nothing safe to mask
    // here beyond what's already omitted).
    const externalStatus = err instanceof UazapiHttpError ? err.status : undefined
    const externalCode = classifyExternalError(
      err instanceof UazapiHttpError ? err.message : undefined,
    )
    console.error('[uazapi/webhook/status] getWebhookConfiguration failed', {
      externalStatus,
      externalCode,
    })

    if (err instanceof UazapiHttpError && [401, 403, 404].includes(err.status)) {
      return NextResponse.json(
        { error: 'UAZAPI instance not found or invalid.', code: 'instance_invalid' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
  }
}
