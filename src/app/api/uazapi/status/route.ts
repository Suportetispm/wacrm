import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import { getInstanceStatus, UazapiHttpError } from '@/lib/whatsapp/uazapi-api'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

/**
 * GET /api/uazapi/status
 *
 * Polls the current connection state of the caller's active UAZAPI
 * instance. Any account member may check status (read-only); only
 * admins can create/connect/disconnect (see instance/route.ts and
 * connect/route.ts).
 */
export async function GET() {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId } = ctx

  const config = await loadActiveWhatsAppConfig(supabase, accountId)
  if (!config) {
    return NextResponse.json({ error: 'WhatsApp not configured for this account' }, { status: 400 })
  }
  if (config.provider !== 'uazapi') {
    return NextResponse.json(
      { error: 'The active connection for this account is not UAZAPI' },
      { status: 400 },
    )
  }

  let result
  try {
    result = await getInstanceStatus({ instanceToken: config.instanceToken })
  } catch (err) {
    console.error(
      '[uazapi/status] getInstanceStatus failed:',
      err instanceof Error ? err.name : 'UnknownError',
    )
    // UAZAPI itself said "unauthorized" / "not found" — the instance
    // was likely deleted or its token is no longer valid server-side.
    // Distinguishable from a generic/transient failure so the client
    // can offer "recreate" instead of just "try again".
    if (err instanceof UazapiHttpError && [401, 403, 404].includes(err.status)) {
      return NextResponse.json(
        { error: 'UAZAPI instance not found or invalid.', code: 'instance_invalid' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
  }

  // Same connected_at convention as POST /connect (see comment there).
  const update: Record<string, unknown> = {
    status: result.status,
    updated_at: new Date().toISOString(),
  }
  if (result.status === 'connected') {
    // Only stamp it on the transition INTO connected — check the
    // current value first so repeated polls don't keep bumping it.
    const { data: row } = await supabase
      .from('whatsapp_config')
      .select('status')
      .eq('account_id', accountId)
      .maybeSingle()
    if (row?.status !== 'connected') {
      update.connected_at = new Date().toISOString()
    }
  } else if (result.status === 'disconnected') {
    update.connected_at = null
  }

  // Best-effort local mirror, guarded against a concurrent provider
  // switch — failure here doesn't affect the response, which reflects
  // UAZAPI's live state regardless.
  const { data: updated, error: updateError } = await supabase
    .from('whatsapp_config')
    .update(update)
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .select('id')
  if (updateError) {
    console.warn('[uazapi/status] status mirror failed:', updateError.message)
  } else if (!updated || updated.length === 0) {
    console.warn('[uazapi/status] status mirror affected 0 rows — provider changed concurrently')
  }

  return NextResponse.json({
    status: result.status,
    connected: result.connected,
    loggedIn: result.loggedIn,
  })
}
