import crypto from 'node:crypto'

/**
 * UAZAPI's configureWebhook() has no signature/secret parameter — unlike
 * Meta (META_APP_SECRET + HMAC), there's no header to verify a request
 * really came from UAZAPI. Instead, the webhook URL itself embeds a
 * deterministic HMAC of the instance id, keyed by a server-only secret.
 * Nothing is stored — recomputed per request, compared in constant time.
 */
export function computeUazapiWebhookToken(instanceId: string): string | null {
  const secret = process.env.UAZAPI_WEBHOOK_SECRET
  if (!secret) return null
  return crypto.createHmac('sha256', secret).update(instanceId).digest('hex')
}

export function verifyUazapiWebhookToken(instanceId: string, providedToken: string): boolean {
  const expected = computeUazapiWebhookToken(instanceId)
  if (!expected) {
    console.error('[uazapi/webhook] UAZAPI_WEBHOOK_SECRET is not set — rejecting request.')
    return false
  }
  if (!providedToken) return false
  const a = Buffer.from(providedToken)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
