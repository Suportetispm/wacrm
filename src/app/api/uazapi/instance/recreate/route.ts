import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { createInstance, getInstanceStatus, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/uazapi/instance/recreate   body: { config_id }
 *
 * ETAPA 078A-PREP — RECRIAR uma conexão UAZAPI existente, IN-PLACE.
 *
 * Replaces the dead external instance behind ONE existing
 * `whatsapp_config` row with a freshly provisioned one and UPDATEs that
 * same row. The row's `id`, `account_id`, `provider` and everything
 * else (default_queue_id, dormant legacy Meta credentials, and — from
 * 078A on — every `conversations.whatsapp_config_id` pointing at it)
 * stay exactly as they were. It never inserts and never deletes a row,
 * so:
 *   - it is NOT "a new connection" and deliberately does NOT consult
 *     the multi_connection_enabled gate (POST /api/uazapi/instance is
 *     the only "create a new connection" operation, and stays gated);
 *   - it keeps working after 078A's NO ACTION FK makes hard-deleting a
 *     referenced whatsapp_config impossible.
 *
 * Replaces the old UI sequence DELETE /api/uazapi/instance + POST
 * /api/uazapi/instance, which lost the row id (and, on legacy rows with
 * dormant Meta credentials, left a restored Meta row PLUS a new UAZAPI
 * row — two connections).
 *
 * Safety rules, all checked before any external side effect:
 *   - `config_id` is explicit and must belong to the caller's account
 *     (never "the primary row" — with several connections that would
 *     be a guess);
 *   - the row must be provider 'uazapi';
 *   - the CURRENT instance must be confirmed invalid by UAZAPI itself
 *     (401/403/404 on /instance/status — same rule GET /status uses to
 *     report `instance_invalid`), or have no usable token at all.
 *     Recreating a healthy instance would silently disconnect a
 *     working number, so that is refused (409 instance_still_valid).
 *     A transient UAZAPI failure is 502 — we can't tell, so we don't.
 *
 * Failure behavior: createInstance/encrypt failing leaves the row
 * untouched. The final UPDATE is conditioned on the old
 * uazapi_instance_id still being there (optimistic concurrency) — a
 * concurrent recreate makes this one a 409 instead of overwriting.
 *
 * Like DELETE, never calls any UAZAPI endpoint to remove the old
 * remote instance (no such contract confirmed) — it may still exist
 * on the UAZAPI server. Its webhook events stop resolving to this row
 * (lookup is by uazapi_instance_id), so they are ignored with 404.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId, account } = ctx

  let body: { config_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const configId = body?.config_id
  if (typeof configId !== 'string' || !UUID_PATTERN.test(configId)) {
    return NextResponse.json({ error: 'config_id is required' }, { status: 400 })
  }

  const { data: row, error: rowError } = await supabase
    .from('whatsapp_config')
    .select('id, account_id, provider, uazapi_instance_id, uazapi_instance_token, uazapi_instance_name')
    .eq('id', configId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (rowError) {
    console.error('[uazapi/instance/recreate] config lookup failed:', rowError.message)
    return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'WhatsApp connection not found' }, { status: 404 })
  }
  if (row.provider !== 'uazapi') {
    return NextResponse.json(
      { error: 'This connection is not a UAZAPI connection' },
      { status: 400 },
    )
  }

  // Is the current instance really gone? No token at all (or one we can
  // no longer decrypt) means there is nothing usable to keep.
  let currentToken: string | null = null
  if (row.uazapi_instance_token) {
    try {
      currentToken = decrypt(row.uazapi_instance_token)
    } catch {
      currentToken = null
    }
  }
  if (currentToken) {
    try {
      await getInstanceStatus({ instanceToken: currentToken })
      return NextResponse.json(
        {
          error: 'The current UAZAPI instance is still valid. Reconnect it instead of recreating it.',
          code: 'instance_still_valid',
        },
        { status: 409 },
      )
    } catch (err) {
      const confirmedInvalid =
        err instanceof UazapiHttpError && [401, 403, 404].includes(err.status)
      if (!confirmedInvalid) {
        console.error(
          '[uazapi/instance/recreate] could not verify current instance:',
          err instanceof Error ? err.name : 'UnknownError',
        )
        return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
      }
    }
  }
  currentToken = null

  const instanceName = (row.uazapi_instance_name || account.name || accountId).slice(0, 60)

  let created
  try {
    created = await createInstance({ name: instanceName })
  } catch (err) {
    console.error(
      '[uazapi/instance/recreate] createInstance failed:',
      err instanceof Error ? err.name : 'UnknownError',
    )
    return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
  }

  let encryptedToken: string
  try {
    encryptedToken = encrypt(created.instanceToken)
  } catch (err) {
    console.error(
      '[uazapi/instance/recreate] token encryption failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json(
      {
        error:
          'Failed to encrypt instance token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
      },
      { status: 500 },
    )
  }

  let update = supabase
    .from('whatsapp_config')
    .update({
      uazapi_instance_id: created.instanceId,
      uazapi_instance_token: encryptedToken,
      uazapi_instance_name: instanceName,
      status: 'disconnected',
      connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
  update = row.uazapi_instance_id
    ? update.eq('uazapi_instance_id', row.uazapi_instance_id)
    : update.is('uazapi_instance_id', null)

  const { data: updated, error: updateError } = await update.select('id')

  if (updateError) {
    console.error('[uazapi/instance/recreate] update failed:', updateError.message)
    return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'Configuration changed concurrently. Please retry.' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: true,
    provider: 'uazapi',
    configId: row.id,
    recreated: true,
    note: "The previous UAZAPI instance was not deleted on the UAZAPI server — only this connection was pointed at a new instance.",
  })
}
