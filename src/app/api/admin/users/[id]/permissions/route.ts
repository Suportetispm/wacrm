// ============================================================
// /api/admin/users/[id]/permissions
//
//   GET — overrides brutos + permissões efetivas de um usuário-alvo.
//   PUT — cria/edita/limpa overrides individuais desse usuário.
//
// Platform admin apenas (requirePlatformAdmin()) — totalmente
// separado da autorização de tenant. Overrides só existem para
// account_role = 'agent' nesta fase; owner/admin/viewer nunca têm
// linhas em user_permission_overrides, e esta rota nunca cria uma
// para eles (ver a checagem `user.account_role !== 'agent'` abaixo).
//
// account_id nunca vem do client — é sempre resolvido server-side a
// partir do usuário-alvo real via fetchPlatformUser() (o mesmo helper
// que GET/PATCH /api/admin/users/[id] já usa), então um id forjado ou
// uma conta arbitrária nunca chegam a setOverrides()/resetOverrides().
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { getEffectivePermissions } from '@/lib/auth/permission-guard'
import { isPermissionKey, type PermissionKey } from '@/lib/auth/permissions'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { fetchPlatformUser } from '@/lib/platform/users'
import { loadOverridesForUser, setOverrides } from '@/lib/permissions/store'
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
  const user = await fetchPlatformUser(supabaseAdmin(), id)
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Não é erro — a UI (editar usuário) só mostra a seção Permissões
  // quando o account_role JÁ SALVO é agent; um GET direto para um
  // owner/admin/viewer volta "não aplicável" em vez de 400/403, para
  // que o front possa checar antes de decidir renderizar.
  if (user.account_role !== 'agent') {
    return NextResponse.json({ applicable: false, role: user.account_role })
  }

  const overrides = await loadOverridesForUser(user.account.id, user.id)
  const effective = await getEffectivePermissions({
    role: 'agent',
    accountId: user.account.id,
    userId: user.id,
  })

  return NextResponse.json({
    applicable: true,
    role: user.account_role,
    overrides: Object.fromEntries(overrides),
    effective,
  })
}

interface PutBody {
  overrides?: unknown
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const limit = await checkRateLimit(`platform:permissionsUpdate:${ctx.userId}`, RATE_LIMITS.platformAdminAction)
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

  const body = (await request.json().catch(() => null)) as PutBody | null
  if (!body || typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides)) {
    return NextResponse.json({ error: "'overrides' must be an object" }, { status: 400 })
  }

  const rawChanges = body.overrides as Record<string, unknown>
  const changes: Partial<Record<PermissionKey, boolean | null>> = {}
  for (const [key, value] of Object.entries(rawChanges)) {
    // Barreira em código, além do CHECK constraint do banco: nenhuma
    // chave fora do catálogo (ex.: 'superadmin.access') chega perto de
    // setOverrides().
    if (!isPermissionKey(key)) {
      return NextResponse.json({ error: `Unknown permission key: '${key}'` }, { status: 400 })
    }
    if (value !== null && typeof value !== 'boolean') {
      return NextResponse.json(
        { error: `Value for '${key}' must be true, false, or null (Herdar)` },
        { status: 400 },
      )
    }
    changes[key] = value
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'Provide at least one override to change' }, { status: 400 })
  }

  await setOverrides(user.account.id, user.id, changes, ctx.userId)

  const overrides = await loadOverridesForUser(user.account.id, user.id)
  const effective = await getEffectivePermissions({
    role: 'agent',
    accountId: user.account.id,
    userId: user.id,
  })

  return NextResponse.json({
    applicable: true,
    role: user.account_role,
    overrides: Object.fromEntries(overrides),
    effective,
  })
}

