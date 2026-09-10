// ============================================================
// POST /api/admin/users/[id]/permissions/reset
//
// "Restaurar permissões padrão" — apaga TODOS os overrides deste
// usuário (todas as linhas em user_permission_overrides para o par
// account_id/user_id dele). Não altera account_role nem qualquer
// outro campo do usuário. Platform admin apenas.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { getEffectivePermissions } from '@/lib/auth/permission-guard'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { fetchPlatformUser } from '@/lib/platform/users'
import { resetOverrides } from '@/lib/permissions/store'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const limit = await checkRateLimit(`platform:permissionsReset:${ctx.userId}`, RATE_LIMITS.platformAdminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const { id } = await params
  const user = await fetchPlatformUser(supabaseAdmin(), id)
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (user.account_role !== 'agent') {
    return NextResponse.json(
      { error: 'Permission overrides only apply to agent users' },
      { status: 400 },
    )
  }

  await resetOverrides(user.account.id, user.id)

  const effective = await getEffectivePermissions({
    role: 'agent',
    accountId: user.account.id,
    userId: user.id,
  })

  return NextResponse.json({ applicable: true, role: user.account_role, overrides: {}, effective })
}
