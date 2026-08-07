// ============================================================
// /api/admin/accounts
//
//   GET  — lista todas as empresas da plataforma.  Platform admin.
//   POST — cria uma empresa nova + primeiro owner. Platform admin.
//
// Nunca usa getCurrentAccount()/requireRole() — a autorização aqui é
// exclusivamente requirePlatformAdmin(), que não tem noção nenhuma
// de account_id/tenant role (ver src/lib/auth/platform-admin.ts).
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { platformRpcErrorToResponse } from '@/lib/platform/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET() {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  // service_role: um platform admin não é membro de nenhuma dessas
  // contas, então o client RLS-scoped não enxergaria nenhuma linha
  // aqui (accounts_select exige is_account_member). O cruzamento de
  // contas só é legítimo porque requirePlatformAdmin() já autorizou.
  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('accounts')
    .select('id, name, owner_user_id, is_active, disabled_at, default_currency, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[GET /api/admin/accounts] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
  }

  return NextResponse.json({ accounts: data ?? [] })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const limit = checkRateLimit(
    `platform:accountCreate:${ctx.userId}`,
    RATE_LIMITS.platformAdminAction,
  )
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; owner_user_id?: unknown }
    | null

  if (typeof body?.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ error: "'name' is required" }, { status: 400 })
  }
  if (typeof body?.owner_user_id !== 'string' || body.owner_user_id.trim().length === 0) {
    return NextResponse.json({ error: "'owner_user_id' is required" }, { status: 400 })
  }

  // RLS-scoped client (não service_role): a RPC é SECURITY DEFINER e
  // valida o chamador via auth.uid() internamente — precisa da sessão
  // real para isso resolver, não do bypass do service_role.
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('platform_create_account', {
    p_name: body.name,
    p_owner_user_id: body.owner_user_id,
  })

  if (error) return platformRpcErrorToResponse(error, 'Failed to create account')

  return NextResponse.json({ account_id: data }, { status: 201 })
}
