// ============================================================
// /api/admin/users
//
//   GET  — lists tenant users (account_role IN admin|agent) across
//          every company. Platform admin.
//   POST — creates a user directly: auth.users + profile attached to
//          the target company, in one guarded flow. Platform admin.
//
// Like /api/admin/accounts, this never uses getCurrentAccount()/
// requireRole() — authorization here is exclusively
// requirePlatformAdmin() (see src/lib/auth/platform-admin.ts).
//
// owner and viewer profiles are never surfaced or created by this
// route — owner is a technical/structural role (see
// transfer_account_ownership, 018_account_member_rpcs.sql) and
// viewer is not part of this product surface. See
// src/lib/platform/users.ts.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { platformRpcErrorToResponse } from '@/lib/platform/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { fetchPlatformUser, isManagedAccountRole, MANAGED_ACCOUNT_ROLES } from '@/lib/platform/users'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  const roleParam = url.searchParams.get('role')
  const isActiveParam = url.searchParams.get('is_active')
  const q = url.searchParams.get('q')?.trim()

  if (roleParam !== null && !isManagedAccountRole(roleParam)) {
    return NextResponse.json({ error: "'role' must be 'admin' or 'agent'" }, { status: 400 })
  }

  let isActive: boolean | null = null
  if (isActiveParam !== null) {
    if (isActiveParam !== 'true' && isActiveParam !== 'false') {
      return NextResponse.json({ error: "'is_active' must be 'true' or 'false'" }, { status: 400 })
    }
    isActive = isActiveParam === 'true'
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? '')
  const rawOffset = Number(url.searchParams.get('offset') ?? '')
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0

  // service_role: a platform admin is not a member of any of these
  // accounts, so the RLS-scoped client would see zero rows here —
  // the cross-tenant read is legitimate only because
  // requirePlatformAdmin() already authorized the caller above.
  const admin = supabaseAdmin()
  let query = admin
    .from('profiles')
    .select('user_id, full_name, email, account_id, account_role, is_active, created_at', {
      count: 'exact',
    })
    .in('account_role', roleParam ? [roleParam] : MANAGED_ACCOUNT_ROLES)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (accountId) query = query.eq('account_id', accountId)
  if (isActive !== null) query = query.eq('is_active', isActive)
  if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)

  const { data: profiles, error, count } = await query

  if (error) {
    console.error('[GET /api/admin/users] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load users' }, { status: 500 })
  }

  const rows = profiles ?? []
  if (rows.length === 0) {
    return NextResponse.json({ users: [], total: count ?? 0 })
  }

  const accountIds = [...new Set(rows.map((r) => r.account_id as string))]
  const userIds = rows.map((r) => r.user_id as string)

  const { data: accountRows } = await admin.from('accounts').select('id, name').in('id', accountIds)
  const accountById = new Map((accountRows ?? []).map((a) => [a.id, a]))

  const { data: memberships } = await admin
    .from('queue_members')
    .select('user_id, queue_id')
    .in('user_id', userIds)

  const queueIds = [...new Set((memberships ?? []).map((m) => m.queue_id as string))]
  const { data: queueRows } =
    queueIds.length > 0
      ? await admin.from('queues').select('id, name, color').in('id', queueIds)
      : { data: [] as { id: string; name: string; color: string }[] }
  const queueById = new Map((queueRows ?? []).map((q) => [q.id, q]))

  const queuesByUser = new Map<string, { id: string; name: string; color: string }[]>()
  for (const m of memberships ?? []) {
    const queue = queueById.get(m.queue_id)
    if (!queue) continue
    const list = queuesByUser.get(m.user_id) ?? []
    list.push(queue)
    queuesByUser.set(m.user_id, list)
  }

  const users = rows.map((r) => ({
    id: r.user_id,
    full_name: r.full_name,
    email: r.email,
    account: accountById.get(r.account_id) ?? null,
    account_role: r.account_role,
    is_active: r.is_active,
    queues: queuesByUser.get(r.user_id) ?? [],
    created_at: r.created_at,
  }))

  return NextResponse.json({ users, total: count ?? users.length })
}

interface CreateUserBody {
  full_name?: unknown
  email?: unknown
  password?: unknown
  account_id?: unknown
  account_role?: unknown
  queue_ids?: unknown
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const limit = checkRateLimit(`platform:userCreate:${ctx.userId}`, RATE_LIMITS.platformAdminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as CreateUserBody | null

  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''
  if (!fullName) return NextResponse.json({ error: "'full_name' is required" }, { status: 400 })
  if (fullName.length > 120) {
    return NextResponse.json({ error: "'full_name' must be 120 characters or fewer" }, { status: 400 })
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid 'email' is required" }, { status: 400 })
  }

  const password = typeof body?.password === 'string' ? body.password : ''
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `'password' must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    )
  }

  const accountId =
    typeof body?.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : ''
  if (!accountId) return NextResponse.json({ error: "'account_id' is required" }, { status: 400 })

  if (!isManagedAccountRole(body?.account_role)) {
    return NextResponse.json({ error: "'account_role' must be 'admin' or 'agent'" }, { status: 400 })
  }
  const accountRole = body.account_role

  let queueIds: string[] | null = null
  if (body?.queue_ids !== undefined) {
    if (
      !Array.isArray(body.queue_ids) ||
      body.queue_ids.some((q) => typeof q !== 'string' || !q)
    ) {
      return NextResponse.json({ error: "'queue_ids' must be an array of strings" }, { status: 400 })
    }
    queueIds = [...new Set(body.queue_ids as string[])]
  }

  const admin = supabaseAdmin()

  // Validate company + queues BEFORE touching auth.users — an error
  // already knowable up front should never cost an orphaned auth
  // user needing compensation below.
  const { data: account } = await admin
    .from('accounts')
    .select('id, is_active')
    .eq('id', accountId)
    .maybeSingle()
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 400 })
  if (!account.is_active) return NextResponse.json({ error: 'Account is disabled' }, { status: 400 })

  if (queueIds && queueIds.length > 0) {
    const { data: matchedQueues } = await admin
      .from('queues')
      .select('id')
      .eq('account_id', accountId)
      .in('id', queueIds)
    if ((matchedQueues ?? []).length !== queueIds.length) {
      return NextResponse.json(
        { error: 'One or more queues do not belong to this account' },
        { status: 400 },
      )
    }
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })

  if (createErr || !created?.user) {
    const isConflict =
      createErr?.status === 422 || /already.*(registered|exists)/i.test(createErr?.message ?? '')
    if (isConflict) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 })
    }
    console.error(
      '[POST /api/admin/users] auth.admin.createUser failed:',
      createErr?.status,
    )
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
  }

  const newUserId = created.user.id

  // RLS-scoped client (not service_role): platform_attach_user_to_
  // account is SECURITY DEFINER and validates the caller via
  // auth.uid() internally — it needs the real session for that.
  const supabase = await createClient()
  const { error: attachErr } = await supabase.rpc('platform_attach_user_to_account', {
    p_user_id: newUserId,
    p_account_id: accountId,
    p_account_role: accountRole,
    p_full_name: fullName,
    p_queue_ids: queueIds,
  })

  if (attachErr) {
    // Compensation: this auth user was created by THIS call — we
    // have its id straight from createUser(), never derived from
    // email — and the account-linking step failed. Remove only this
    // freshly created user; never a pre-existing one.
    const { error: deleteErr } = await admin.auth.admin.deleteUser(newUserId)
    if (deleteErr) {
      console.error(
        '[POST /api/admin/users] compensation deleteUser failed for a newly created auth user; manual cleanup required',
      )
      return NextResponse.json(
        {
          error:
            'Failed to finish creating the user, and automatic cleanup also failed. Contact an administrator.',
        },
        { status: 500 },
      )
    }
    return platformRpcErrorToResponse(attachErr, 'Failed to attach user to account')
  }

  const sanitized = await fetchPlatformUser(admin, newUserId)
  if (!sanitized) {
    console.error('[POST /api/admin/users] user attached but could not be reloaded')
    return NextResponse.json({ error: 'User created but could not be loaded' }, { status: 500 })
  }

  return NextResponse.json({ user: sanitized }, { status: 201 })
}
