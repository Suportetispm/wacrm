// ============================================================
// /api/admin/accounts
//
//   GET  — lista todas as empresas da plataforma (com contagem de
//          usuários por empresa). Platform admin.
//   POST — cria uma empresa nova + primeiro owner. Platform admin.
//          Dois modos, mutuamente exclusivos:
//            (a) owner_user_id — usuário JÁ existente em auth.users
//                (fluxo original, 047 "estratégia A"): passa direto
//                para platform_create_account.
//            (b) owner_full_name/owner_email/owner_password — cria o
//                usuário primeiro (mesma primitiva de
//                /api/admin/users: admin.auth.admin.createUser()),
//                depois chama a MESMA RPC platform_create_account com
//                o id recém-criado. Esta é a forma que a UI ("Nova
//                empresa") realmente usa — nunca pede um UUID cru ao
//                operador.
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
import { compensateFailedUserCreation } from '@/lib/platform/user-compensation'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

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

  const rows = data ?? []
  if (rows.length === 0) {
    return NextResponse.json({ accounts: [] })
  }

  // Contagem de usuários por empresa — segunda consulta em vez de um
  // embed do PostgREST, mesmo padrão já usado em
  // src/app/api/internal-tickets/teams/route.ts para
  // active_member_count.
  const accountIds = rows.map((a) => a.id)
  const { data: profileRows } = await admin.from('profiles').select('account_id').in('account_id', accountIds)
  const countByAccount = new Map<string, number>()
  for (const p of profileRows ?? []) {
    countByAccount.set(p.account_id, (countByAccount.get(p.account_id) ?? 0) + 1)
  }

  const accounts = rows.map((a) => ({ ...a, user_count: countByAccount.get(a.id) ?? 0 }))

  return NextResponse.json({ accounts })
}

interface CreateAccountBody {
  name?: unknown
  owner_user_id?: unknown
  owner_full_name?: unknown
  owner_email?: unknown
  owner_password?: unknown
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

  const body = (await request.json().catch(() => null)) as CreateAccountBody | null

  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: "'name' is required" }, { status: 400 })

  const ownerUserId =
    typeof body?.owner_user_id === 'string' && body.owner_user_id.trim() ? body.owner_user_id.trim() : ''

  // RLS-scoped client (não service_role): a RPC é SECURITY DEFINER e
  // valida o chamador via auth.uid() internamente — precisa da sessão
  // real para isso resolver, não do bypass do service_role.
  const supabase = await createClient()

  if (ownerUserId) {
    // Modo (a) — usuário já existente, mesmo comportamento de sempre.
    const { data, error } = await supabase.rpc('platform_create_account', {
      p_name: name,
      p_owner_user_id: ownerUserId,
    })
    if (error) return platformRpcErrorToResponse(error, 'Failed to create account')
    return NextResponse.json({ account_id: data, owner_user_id: ownerUserId }, { status: 201 })
  }

  // Modo (b) — cria o owner junto. Campos obrigatórios: nome/e-mail/senha.
  const ownerFullName = typeof body?.owner_full_name === 'string' ? body.owner_full_name.trim() : ''
  if (!ownerFullName) {
    return NextResponse.json({ error: "'owner_full_name' is required" }, { status: 400 })
  }
  if (ownerFullName.length > 120) {
    return NextResponse.json({ error: "'owner_full_name' must be 120 characters or fewer" }, { status: 400 })
  }

  const ownerEmail = typeof body?.owner_email === 'string' ? body.owner_email.trim().toLowerCase() : ''
  if (!ownerEmail || !EMAIL_RE.test(ownerEmail)) {
    return NextResponse.json({ error: "A valid 'owner_email' is required" }, { status: 400 })
  }

  const ownerPassword = typeof body?.owner_password === 'string' ? body.owner_password : ''
  if (ownerPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `'owner_password' must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
    user_metadata: { full_name: ownerFullName },
  })

  if (createErr || !created?.user) {
    const isConflict =
      createErr?.status === 422 || /already.*(registered|exists)/i.test(createErr?.message ?? '')
    if (isConflict) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 })
    }
    console.error('[POST /api/admin/accounts] auth.admin.createUser failed:', createErr?.status)
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 })
  }

  const newOwnerId = created.user.id

  const { data, error } = await supabase.rpc('platform_create_account', {
    p_name: name,
    p_owner_user_id: newOwnerId,
  })

  if (error) {
    // Compensation: same shape as POST /api/admin/users — the auth
    // user was created by THIS call, handle_new_user() already gave
    // it a temp personal account, and platform_create_account failed
    // to convert it into the target company. Remove only this
    // freshly created user + its temp account, never a pre-existing one.
    const compensation = await compensateFailedUserCreation(admin, newOwnerId)
    if (!compensation.ok) {
      return NextResponse.json(
        {
          error:
            'Failed to finish creating the company, and automatic cleanup also failed. Contact an administrator.',
        },
        { status: 500 },
      )
    }
    return platformRpcErrorToResponse(error, 'Failed to create account')
  }

  return NextResponse.json({ account_id: data, owner_user_id: newOwnerId }, { status: 201 })
}
