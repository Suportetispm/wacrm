import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/account/admin-client'
import { checkNewConnectionAllowed } from '@/lib/whatsapp/connection-gate'

/**
 * GET /api/whatsapp/connection-gate
 *
 * ETAPA 078-0 — read-only: tells Settings whether "add a connection"
 * actions should be offered to this account. The browser cannot read
 * account_feature_flags itself (no RLS policy for authenticated), so
 * this is the only way the UI learns the flag. Purely UX — the real
 * enforcement lives in POST /api/uazapi/instance and
 * POST /api/whatsapp/config, which call the same gate.
 */
export async function GET() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const gate = await checkNewConnectionAllowed(supabaseAdmin(), ctx.accountId)
  if (!gate.allowed && gate.reason === 'lookup_failed') {
    return NextResponse.json({ error: 'Failed to load connection settings' }, { status: 500 })
  }

  return NextResponse.json({
    can_add_connection: gate.allowed,
    multi_connection_enabled: gate.allowed ? gate.multiConnectionEnabled : false,
    connection_count: gate.connectionCount,
  })
}
