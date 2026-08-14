import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal team members — GET lists every membership row for this
// team, active AND inactive (the UI needs to see inactive rows too,
// to offer "reactivate" instead of a duplicate add — see POST below).
// POST adds a member (admin/owner only).
//
// team_id/user_id/account_id are immutable once a row exists
// (prevent_system_column_change trigger, migration 052) and there is
// no DELETE RLS policy on internal_team_members — entry/exit is
// exclusively via is_active. UNIQUE(team_id, user_id) means a second
// INSERT for the same pair always fails; if an inactive row already
// exists for this (team_id, user_id), POST reactivates it (UPDATE
// is_active=true) instead of attempting a duplicate INSERT.

const GENERIC_ERROR = 'Failed to process the request'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: teamId } = await params
  try {
    const { supabase } = await getCurrentAccount()
    const { data: members, error } = await supabase
      .from('internal_team_members')
      .select('*')
      .eq('team_id', teamId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[internal-tickets/teams/[id]/members] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!members || members.length === 0) return NextResponse.json({ members: [] })

    // Two round trips instead of a PostgREST embed — same reasoning as
    // queue_members: the FK to profiles is composite ((user_id,
    // account_id), added purely for the tenancy guarantee), not the
    // simple single-column FK PostgREST's embedding reliably infers.
    const userIds = members.map((m) => m.user_id)
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, full_name, email, avatar_url')
      .in('user_id', userIds)
    const byUserId = new Map((profiles ?? []).map((p) => [p.user_id, p]))

    return NextResponse.json({
      members: members.map((m) => ({ ...m, profile: byUserId.get(m.user_id) ?? null })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: teamId } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!userId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })

  // Clean 400s instead of raw composite-FK-violation 500s: confirm the
  // target team is actually in THIS account before attempting anything.
  const { data: targetTeam } = await ctx.supabase
    .from('internal_teams')
    .select('id')
    .eq('id', teamId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!targetTeam) {
    return NextResponse.json({ error: 'Team not found in this account' }, { status: 404 })
  }

  // Target profile must exist in this account AND be active — an
  // inactive profile can never become an active member
  // (internal_team_members_validate_active trigger enforces this
  // independently; this is the clean-400 pre-check).
  const { data: targetProfile } = await ctx.supabase
    .from('profiles')
    .select('user_id, is_active')
    .eq('user_id', userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!targetProfile) {
    return NextResponse.json({ error: 'user_id must belong to a profile in this account' }, { status: 400 })
  }
  if (!targetProfile.is_active) {
    return NextResponse.json({ error: 'Only active users can be added as team members' }, { status: 400 })
  }

  // UNIQUE(team_id, user_id) + no physical DELETE means a membership
  // row for this exact pair can already exist, inactive, from a
  // previous removal. Reactivate it instead of attempting a duplicate
  // INSERT (which would always fail with 23505 for this pair).
  const { data: existing } = await ctx.supabase
    .from('internal_team_members')
    .select('id, is_active')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (existing) {
    if (existing.is_active) {
      return NextResponse.json({ error: 'This user is already a member of the team' }, { status: 409 })
    }
    const { data, error } = await supabaseAdmin()
      .from('internal_team_members')
      .update({ is_active: true })
      .eq('id', existing.id)
      .eq('account_id', ctx.accountId)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[internal-tickets/teams/[id]/members] POST reactivate failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ member: data })
  }

  const { data, error } = await supabaseAdmin()
    .from('internal_team_members')
    .insert({
      account_id: ctx.accountId,
      team_id: teamId,
      user_id: userId,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/teams/[id]/members] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'This user is already a member of the team' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ member: data }, { status: 201 })
}
