import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import { computeUazapiWebhookToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { configureWebhook, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'

const ALLOWED_HOSTNAME_SUFFIX = '.trycloudflare.com'
const MAX_BASE_URL_LENGTH = 200

function maskInstanceId(id: string): string {
  if (id.length <= 6) return '***'
  return `${id.slice(0, 3)}…${id.slice(-2)}`
}

/**
 * Validates `baseUrl` per ETAPA 8.1E rules: https only, hostname must
 * end exactly in `.trycloudflare.com` (with a real subdomain — the
 * bare suffix alone is rejected), no userinfo, no query/hash, no
 * custom port, empty/"/" pathname only. Returns the normalized
 * `url.origin` (never anything derived from path/query/hash) or null.
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
 * events at a temporary tunnel URL. Admin-only; `accountId` is always
 * resolved from the authenticated session, never from the request
 * body. The caller supplies ONLY the tunnel's base URL — instance id,
 * instance token, HMAC, event list, and the final webhook URL are all
 * resolved/computed server-side and never accepted from the client,
 * never logged, and never returned in the response.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId } = ctx

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

  const baseOrigin = validateTunnelBaseUrl(rawBaseUrl)
  if (!baseOrigin) {
    return NextResponse.json({ error: 'invalid_base_url' }, { status: 400 })
  }

  // accountId intentionally omitted from this log line entirely —
  // not needed for diagnosis, and there's no safe partial-mask of a
  // UUID worth the complexity when omitting is simpler and stricter.
  console.log('[uazapi/webhook/register] starting registration')

  const config = await loadActiveWhatsAppConfig(supabase, accountId)
  if (!config || config.provider !== 'uazapi' || !config.instanceToken) {
    return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 400 })
  }

  // loadActiveWhatsAppConfig() doesn't expose uazapi_instance_id (only
  // instanceToken + configId) — one small follow-up read through the
  // same RLS-scoped client from requireRole(); no service role needed.
  const { data: instanceRow, error: instanceRowError } = await supabase
    .from('whatsapp_config')
    .select('uazapi_instance_id')
    .eq('id', config.configId)
    .maybeSingle()

  if (instanceRowError || !instanceRow?.uazapi_instance_id) {
    return NextResponse.json({ error: 'instance_invalid' }, { status: 400 })
  }

  const instanceId: string = instanceRow.uazapi_instance_id

  const hmac = computeUazapiWebhookToken(instanceId)
  if (!hmac) {
    // UAZAPI_WEBHOOK_SECRET missing — fail closed, same convention as
    // every other caller of computeUazapiWebhookToken/verifyUazapiWebhookToken.
    console.error('[uazapi/webhook/register] UAZAPI_WEBHOOK_SECRET is not set')
    return NextResponse.json({ error: 'webhook_registration_failed' }, { status: 500 })
  }

  // Full URL assembled ONLY in memory — never logged, returned, or
  // persisted anywhere.
  const webhookUrl = `${baseOrigin}/api/uazapi/webhook/${instanceId}/${hmac}`

  // ------------------------------------------------------------------
  // 'messages' is a best-effort guess, NOT confirmed against UAZAPI's
  // official documentation. docs.uazapi.com is a JS-rendered SPA we
  // could not extract a schema from; the live server's own
  // /openapi.json, /swagger.json, and /docs paths also returned
  // nothing usable without credentials (see ETAPA 8.1D review). The
  // first real call may be rejected by UAZAPI with a validation
  // error — if so, this literal must be corrected based on that real
  // response, not guessed further.
  // ------------------------------------------------------------------
  const events = ['messages']
  // Confirmed real via search (matches the existing comment in
  // uazapi-api.ts) — suppresses echoes of our own outbound sends.
  const excludeMessages = ['wasSentByApi']

  try {
    await configureWebhook({
      instanceToken: config.instanceToken,
      url: webhookUrl,
      events,
      excludeMessages,
    })
  } catch (err) {
    // Never surface err.message (may embed the URL or the external
    // response body) and never log the external response body itself
    // — only the external HTTP status, when available, plus the
    // masked instance id.
    const externalStatus = err instanceof UazapiHttpError ? err.status : undefined
    console.error(
      '[uazapi/webhook/register] configureWebhook failed',
      {
        instanceId: maskInstanceId(instanceId),
        externalStatus,
      },
    )
    return NextResponse.json({ error: 'webhook_registration_failed' }, { status: 502 })
  }

  console.log('[uazapi/webhook/register] registration succeeded', {
    instanceId: maskInstanceId(instanceId),
  })

  return NextResponse.json({ success: true })
}
