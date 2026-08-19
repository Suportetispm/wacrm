import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import { getWebhookConfiguration, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'
import { classifyExternalError } from '@/lib/whatsapp/uazapi-webhook-register'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

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
