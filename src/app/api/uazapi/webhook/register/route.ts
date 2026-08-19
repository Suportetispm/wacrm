import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import {
  maskInstanceId,
  registerUazapiWebhook,
  resolveConfiguredSiteOrigin,
} from '@/lib/whatsapp/uazapi-webhook-register'

const ALLOWED_HOSTNAME_SUFFIX = '.trycloudflare.com'
const MAX_BASE_URL_LENGTH = 200

/**
 * Validates `baseUrl` per ETAPA 8.1E rules: https only, hostname must
 * end exactly in `.trycloudflare.com` (with a real subdomain — the
 * bare suffix alone is rejected), no userinfo, no query/hash, no
 * custom port, empty/"/" pathname only. Returns the normalized
 * `url.origin` (never anything derived from path/query/hash) or null.
 *
 * Dev-only fallback path — only reached when `NEXT_PUBLIC_SITE_URL`
 * isn't configured (see `resolveConfiguredSiteOrigin()`). In
 * production the configured origin is used unconditionally and this
 * function is never called.
 */
function validateTunnelBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BASE_URL_LENGTH) {
    return null
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null
  if (!url.hostname.endsWith(ALLOWED_HOSTNAME_SUFFIX)) return null
  if (url.hostname === ALLOWED_HOSTNAME_SUFFIX) return null // bare suffix, no subdomain
  if (url.username || url.password) return null
  if (url.search) return null
  if (url.hash) return null
  if (url.port) return null
  if (url.pathname !== '' && url.pathname !== '/') return null

  return url.origin
}

/**
 * POST /api/uazapi/webhook/register
 *
 * Registers this account's active UAZAPI instance to receive webhook
 * events. Admin-only; `accountId` is always resolved from the
 * authenticated session, never from the request body. Instance id,
 * instance token, HMAC, event list, and the final webhook URL are all
 * resolved/computed server-side and never accepted from the client,
 * never logged, and never returned in the response.
 *
 * Origin resolution — production vs. dev tunnel:
 *   - If `NEXT_PUBLIC_SITE_URL` is configured (production), that's the
 *     ONLY origin ever used — any `baseUrl` in the request body is
 *     ignored entirely, not even read.
 *   - Otherwise (dev, no site URL configured), the caller must supply
 *     `{ baseUrl }` pointing at a `*.trycloudflare.com` tunnel — the
 *     original ETAPA 8.1E contract, unchanged.
 *
 * This is also the manual "contingency" endpoint the Settings UI calls
 * when the webhook status shows anything other than active — the
 * normal path is automatic registration right after connecting (see
 * `ensureUazapiWebhookRegistered` in connect/status routes).
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId } = ctx

  const configuredOrigin = resolveConfiguredSiteOrigin()

  let baseOrigin: string
  if (configuredOrigin.ok) {
    baseOrigin = configuredOrigin.origin
  } else if (configuredOrigin.reason === 'invalid') {
    console.error(
      '[uazapi/webhook/register] NEXT_PUBLIC_SITE_URL is set but not a valid https URL',
    )
    return NextResponse.json({ error: 'site_url_misconfigured' }, { status: 500 })
  } else {
    // Dev fallback — no NEXT_PUBLIC_SITE_URL configured, require a
    // client-supplied tunnel baseUrl (unchanged ETAPA 8.1E contract).
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'invalid_base_url' }, { status: 400 })
    }
    const rawBaseUrl =
      body && typeof body === 'object' && 'baseUrl' in body
        ? (body as { baseUrl: unknown }).baseUrl
        : undefined
    const tunnelOrigin = validateTunnelBaseUrl(rawBaseUrl)
    if (!tunnelOrigin) {
      return NextResponse.json({ error: 'invalid_base_url' }, { status: 400 })
    }
    baseOrigin = tunnelOrigin
  }

  // accountId intentionally omitted from this log line entirely —
  // not needed for diagnosis, and there's no safe partial-mask of a
  // UUID worth the complexity when omitting is simpler and stricter.
  console.log('[uazapi/webhook/register] starting registration')

  const config = await loadActiveWhatsAppConfig(supabase, accountId)
  if (!config || config.provider !== 'uazapi' || !config.instanceToken || !config.uazapiInstanceId) {
    return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 400 })
  }

  const instanceId = config.uazapiInstanceId

  const result = await registerUazapiWebhook({
    instanceToken: config.instanceToken,
    baseOrigin,
    instanceId,
  })

  if (!result.ok) {
    if (result.reason === 'webhook_secret_missing') {
      return NextResponse.json({ error: 'webhook_registration_failed' }, { status: 500 })
    }
    // Never surface the raw external message — only a fixed sanitized
    // code, the external HTTP status, and the masked instance id.
    console.error('[uazapi/webhook/register] configureWebhook failed', {
      instanceId: maskInstanceId(instanceId),
      externalStatus: result.externalStatus,
      externalCode: result.externalCode,
    })
    return NextResponse.json({ error: 'webhook_registration_failed' }, { status: 502 })
  }

  console.log('[uazapi/webhook/register] registration succeeded', {
    instanceId: maskInstanceId(instanceId),
  })

  return NextResponse.json({ success: true })
}
