// ============================================================
// /api/admin/users/[id]
//
//   GET   — detail of one tenant user.                Platform admin.
//   PATCH — edits full_name / account_role / is_active / queues.
//           Platform admin.
//
// No DELETE — users are deactivated (is_active=false), never
// physically removed. Email, account_id and password are
// intentionally not editable through this route in this version (see
// PATCH below) — changing a user's company or credentials is out of
// scope for 6C.3B.
//
// :id is always the auth.users id (== profiles.user_id), matching
// every other user-keyed route in this codebase
// (/api/account/members/[userId]).
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform/admin-client'
import { platformRpcErrorToResponse } from '@/lib/platform/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { fetchPlatformUser, isManagedAccountRole } from '@/lib/platform/users'

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
  const user = await fetchPlatformUser(admin, id)
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  return NextResponse.json({ user })
}

interface UpdateUserBody {
  full_name?: unknown
  account_role?: unknown
  is_active?: unknown
  queue_ids?: unknown
  email?: unknown
  account_id?: unknown
  password?: unknown
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

  const limit = checkRateLimit(`platform:userUpdate:${ctx.userId}`, RATE_LIMITS.platformAdminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const { id } = await params

  const body = (await request.json().catch(() => null)) as UpdateUserBody | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  if (body.email !== undefined || body.account_id !== undefined || body.password !== undefined) {
    return NextResponse.json(
      { error: 'Changing email, account or password is not supported in this version' },
      { status: 400 },
    )
  }

  let fullName: string | null = null
  if (body.full_name !== undefined) {
    if (typeof body.full_name !== 'string' || !body.full_name.trim()) {
      return NextResponse.json({ error: "'full_name' cannot be empty" }, { status: 400 })
    }
    if (body.full_name.trim().length > 120) {
      return NextResponse.json({ error: "'full_name' must be 120 characters or fewer" }, { status: 400 })
    }
    fullName = body.full_name.trim()
  }

  let accountRole: 'admin' | 'agent' | null = null
  if (body.account_role !== undefined) {
    if (!isManagedAccountRole(body.account_role)) {
      return NextResponse.json({ error: "'account_role' must be 'admin' or 'agent'" }, { status: 400 })
    }
    accountRole = body.account_role
  }

  let isActive: boolean | null = null
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: "'is_active' must be a boolean" }, { status: 400 })
    }
    isActive = body.is_active
  }

  const queueIdsProvided = body.queue_ids !== undefined
  let queueIds: string[] | null = null
  if (queueIdsProvided) {
    if (
      !Array.isArray(body.queue_ids) ||
      body.queue_ids.some((q) => typeof q !== 'string' || !q)
    ) {
      return NextResponse.json({ error: "'queue_ids' must be an array of strings" }, { status: 400 })
    }
    queueIds = [...new Set(body.queue_ids as string[])]
  }

  if (fullName === null && accountRole === null && isActive === null && !queueIdsProvided) {
    return NextResponse.json({ error: 'Provide at least one field to update' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // Fast-fail cross-tenant queue assignment before calling the RPC
  // (which re-validates the same thing regardless — defense in
  // depth, not the only check). Skipped when the target profile
  // can't be found here; the RPC below surfaces that as a clean
  // "User not found" either way.
  if (queueIds && queueIds.length > 0) {
    const { data: currentProfile } = await admin
      .from('profiles')
      .select('account_id')
      .eq('user_id', id)
      .maybeSingle()
    if (currentProfile) {
      const { data: matchedQueues } = await admin
        .from('queues')
        .select('id')
        .eq('account_id', currentProfile.account_id)
        .in('id', queueIds)
      if ((matchedQueues ?? []).length !== queueIds.length) {
        return NextResponse.json(
          { error: "One or more queues do not belong to this user's account" },
          { status: 400 },
        )
      }
    }
  }

  // RLS-scoped client — platform_update_user validates auth.uid() by
  // itself. Every parameter is always passed explicitly (null for
  // "leave unchanged") rather than relying on PostgREST default
  // handling for omitted keys.
  const supabase = await createClient()
  const { error } = await supabase.rpc('platform_update_user', {
    p_user_id: id,
    p_full_name: fullName,
    p_account_role: accountRole,
    p_is_active: isActive,
    p_queue_ids: queueIds,
  })

  if (error) return platformRpcErrorToResponse(error, 'Failed to update user')

  const sanitized = await fetchPlatformUser(admin, id)
  if (!sanitized) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  return NextResponse.json({ user: sanitized })
}
