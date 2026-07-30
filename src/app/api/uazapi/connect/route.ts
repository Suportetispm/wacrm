import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadActiveWhatsAppConfig } from '@/lib/whatsapp/active-config'
import { connectInstance } from '@/lib/whatsapp/uazapi-api'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

/**
 * POST /api/uazapi/connect
 *
 * Starts (or resumes) the QR-code connection flow for the caller's
 * active UAZAPI instance. Returns only what the UI needs to render a
 * QR code / pairing code — never the instance token.
 */
export async function POST() {
  let ctx
  try {
    ctx = await requireRole('admin')
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
    result = await connectInstance({ instanceToken: config.instanceToken })
  } catch (err) {
    console.error(
      '[uazapi/connect] connectInstance failed:',
      err instanceof Error ? err.name : 'UnknownError',
    )
    return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
  }

  // connected_at: same convention as whatsapp/config/route.ts (Meta) —
  // timestamp of the most recent CONFIRMED connection. Cleared only
  // on an explicit 'disconnected'; left untouched for
  // 'connecting'/'hibernated' (neither is a confirmed non-connection).
  const update: Record<string, unknown> = {
    status: result.status,
    updated_at: new Date().toISOString(),
  }
  if (result.status === 'disconnected') {
    update.connected_at = null
  }

  // Best-effort local mirror, guarded against a concurrent provider
  // switch — the QR/pairing code is still valid to show even if this
  // write fails or affects zero rows.
  const { data: updated, error: updateError } = await supabase
    .from('whatsapp_config')
    .update(update)
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .select('id')
  if (updateError) {
    console.warn('[uazapi/connect] status mirror failed:', updateError.message)
  } else if (!updated || updated.length === 0) {
    console.warn('[uazapi/connect] status mirror affected 0 rows — provider changed concurrently')
  }

  return NextResponse.json({
    status: result.status,
    qrcode: result.qrcode,
    paircode: result.paircode,
  })
}
