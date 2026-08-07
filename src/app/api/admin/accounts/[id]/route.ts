// ============================================================
// /api/admin/accounts/[id]
//
//   GET   — detalhe de uma empresa.                Platform admin.
//   PATCH — renomeia OU ativa/desativa a empresa.   Platform admin.
//
// O :id da URL só vira alvo de qualquer operação DEPOIS que
// requirePlatformAdmin() já autorizou o chamador globalmente — nunca
// o contrário. Ele nunca é usado para decidir QUEM pode chamar a
// rota, só O QUE a chamada, já autorizada, afeta.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { platformRpcErrorToResponse } from '@/lib/platform/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const { id } = await params

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('accounts')
    .select('id, name, owner_user_id, is_active, disabled_at, default_currency, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[GET /api/admin/accounts/[id]] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  return NextResponse.json({ account: data })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const limit = checkRateLimit(
    `platform:accountUpdate:${ctx.userId}`,
    RATE_LIMITS.platformAdminAction,
  )
  if (!limit.success) return rateLimitResponse(limit)

  const { id } = await params

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; action?: unknown }
    | null

  // RLS-scoped client — as RPCs abaixo validam auth.uid() por dentro.
  const supabase = await createClient()

  if (body?.action !== undefined) {
    if (body.action !== 'enable' && body.action !== 'disable') {
      return NextResponse.json(
        { error: "'action' must be 'enable' or 'disable'" },
        { status: 400 },
      )
    }

    const { error } = await supabase.rpc('platform_set_account_active', {
      p_account_id: id,
      p_is_active: body.action === 'enable',
    })
    if (error) return platformRpcErrorToResponse(error, 'Failed to update account status')

    return NextResponse.json({ ok: true })
  }

  if (typeof body?.name === 'string') {
    const { error } = await supabase.rpc('platform_update_account', {
      p_account_id: id,
      p_name: body.name,
    })
    if (error) return platformRpcErrorToResponse(error, 'Failed to update account')

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Provide either 'name' or 'action'" }, { status: 400 })
}
