/**
 * Shared logic for registering a UAZAPI instance's inbound webhook —
 * used both by the admin-triggered manual endpoint
 * (`/api/uazapi/webhook/register`) and by the automatic triggers that
 * run right after a QR-code connection succeeds (`connect`/`status`
 * routes, via `ensureUazapiWebhookRegistered`).
 *
 * The webhook URL embeds a per-instance HMAC (see
 * `uazapi-webhook-auth.ts`) — nothing here persists a secret; the
 * token is recomputed on every call.
 */

import { computeUazapiWebhookToken } from './uazapi-webhook-auth'
import { configureWebhook, UazapiHttpError } from './uazapi-api'

export function maskInstanceId(id: string): string {
  if (id.length <= 6) return '***'
  return `${id.slice(0, 3)}…${id.slice(-2)}`
}

/**
 * Sanitized bucket for an external UAZAPI error message. Deliberately
 * coarse — a small, fixed enum, never the original text — so a log
 * line can carry a diagnostic signal without risking exposure of
 * whatever the external body actually contained.
 */
export type ExternalErrorCode =
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
export function classifyExternalError(message: string | undefined): ExternalErrorCode {
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

export type ConfiguredOriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'unset' }
  | { ok: false; reason: 'invalid' }

/**
 * Resolves the app's own canonical production origin from
 * `NEXT_PUBLIC_SITE_URL` — the same env var `getBaseUrl()` in
 * `/api/account/invitations` already treats as the operator's
 * explicit, authoritative site URL. Reused here rather than
 * introducing a new variable.
 *
 * Deliberately does NOT fall back to `X-Forwarded-Host`/`Host`
 * headers the way the invitations route does — a webhook URL
 * authorizes an external server to POST into this app, so it must
 * come from server config, never from a request-controllable header.
 * `unset` (dev, no var configured) and `invalid` (set but malformed)
 * are distinguished so a malformed value fails closed instead of
 * silently behaving like `unset`.
 */
export function resolveConfiguredSiteOrigin(): ConfiguredOriginResult {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!raw) return { ok: false, reason: 'unset' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'invalid' }
  return { ok: true, origin: url.origin }
}

/**
 * Full webhook URL assembled ONLY in memory — never logged, returned,
 * or persisted anywhere. Returns null when `UAZAPI_WEBHOOK_SECRET` is
 * unset (fail closed, same convention as every other caller of
 * `computeUazapiWebhookToken`).
 */
export function buildUazapiWebhookUrl(baseOrigin: string, instanceId: string): string | null {
  const hmac = computeUazapiWebhookToken(instanceId)
  if (!hmac) return null
  return `${baseOrigin}/api/uazapi/webhook/${instanceId}/${hmac}`
}

export interface RegisterUazapiWebhookArgs {
  instanceToken: string
  baseOrigin: string
  instanceId: string
}

export type RegisterUazapiWebhookResult =
  | { ok: true }
  | { ok: false; reason: 'webhook_secret_missing' }
  | { ok: false; reason: 'external_error'; externalStatus?: number; externalCode: ExternalErrorCode }

// 'messages' is a best-effort guess, NOT confirmed against UAZAPI's
// official documentation — see the original ETAPA 8.1D/E investigation
// notes in docs/uazapi-webhook-progress.md. Confirmed working in
// practice with a real inbound message.
const WEBHOOK_EVENTS = ['messages']
// Confirmed real via search — suppresses echoes of our own outbound sends.
const WEBHOOK_EXCLUDE_MESSAGES = ['wasSentByApi']

/**
 * Registers `instanceId`'s webhook at `{baseOrigin}/api/uazapi/webhook/{instanceId}/{hmac}`.
 * Never throws — callers get a typed result instead, so a failure
 * here can never take down whatever triggered it (an admin's manual
 * click, or the automatic post-connect flow).
 */
export async function registerUazapiWebhook(
  args: RegisterUazapiWebhookArgs,
): Promise<RegisterUazapiWebhookResult> {
  const { instanceToken, baseOrigin, instanceId } = args

  const webhookUrl = buildUazapiWebhookUrl(baseOrigin, instanceId)
  if (!webhookUrl) {
    console.error('[uazapi-webhook-register] UAZAPI_WEBHOOK_SECRET is not set')
    return { ok: false, reason: 'webhook_secret_missing' }
  }

  try {
    await configureWebhook({
      instanceToken,
      url: webhookUrl,
      events: WEBHOOK_EVENTS,
      excludeMessages: WEBHOOK_EXCLUDE_MESSAGES,
    })
    return { ok: true }
  } catch (err) {
    // Never surface err.message (may embed the URL or the external
    // response body) and never log the external response body itself.
    const externalStatus = err instanceof UazapiHttpError ? err.status : undefined
    const externalCode = classifyExternalError(
      err instanceof UazapiHttpError ? err.message : undefined,
    )
    return { ok: false, reason: 'external_error', externalStatus, externalCode }
  }
}

export interface EnsureUazapiWebhookRegisteredArgs {
  instanceId: string
  instanceToken: string
}

export type EnsureUazapiWebhookRegisteredResult =
  | { ok: true }
  | { ok: false; reason: 'no_production_origin' }
  | { ok: false; reason: 'webhook_secret_missing' }
  | { ok: false; reason: 'external_error'; externalStatus?: number; externalCode: ExternalErrorCode }

/**
 * Idempotent, best-effort webhook registration for the automatic
 * post-connect triggers (`connect`/`status` routes). Only acts when
 * `NEXT_PUBLIC_SITE_URL` is configured (production) — there's no safe
 * automatic origin in dev (the tunnel URL is ephemeral and only known
 * client-side), so dev keeps using the manual button.
 *
 * Never throws. Calling this repeatedly (e.g. every time a status
 * poll resolves to 'connected') is safe — UAZAPI's webhook endpoint
 * is create-or-update ("simple mode"), so re-registering with the
 * same payload is a no-op in effect.
 */
export async function ensureUazapiWebhookRegistered(
  args: EnsureUazapiWebhookRegisteredArgs,
): Promise<EnsureUazapiWebhookRegisteredResult> {
  const { instanceId, instanceToken } = args

  const configuredOrigin = resolveConfiguredSiteOrigin()
  if (!configuredOrigin.ok) {
    if (configuredOrigin.reason === 'invalid') {
      console.error(
        '[uazapi-webhook-register] NEXT_PUBLIC_SITE_URL is set but not a valid https URL — skipping automatic registration',
      )
    }
    // 'unset' is the expected dev state — not logged as an error.
    return { ok: false, reason: 'no_production_origin' }
  }

  const result = await registerUazapiWebhook({
    instanceToken,
    baseOrigin: configuredOrigin.origin,
    instanceId,
  })

  if (result.ok) {
    console.log('[uazapi-webhook-register] automatic registration succeeded', {
      instanceId: maskInstanceId(instanceId),
    })
  } else {
    console.error('[uazapi-webhook-register] automatic registration failed', {
      instanceId: maskInstanceId(instanceId),
      reason: result.reason,
      ...(result.reason === 'external_error'
        ? { externalStatus: result.externalStatus, externalCode: result.externalCode }
        : {}),
    })
  }

  return result
}
