import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// PATCH toggles is_active for one membership row. Admin/owner only,
// scoped by account_id AND team_id (from the route) so a caller can
// never touch another account's — or another team's — membership row.
//
// Deliberately NO DELETE handler on this route: internal_team_members
// has no DELETE RLS policy (migration 052) — removing someone from a
// team is always is_active=false, never a physical delete. team_id/
// user_id are immutable at the DB level regardless of what a PATCH
// body contains, so only is_active is ever accepted here.

const GENERIC_ERROR = 'Failed to process the request'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const { id: teamId, memberId } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  if (!('is_active' in body)) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }
  const wantActive = Boolean(body.is_active)

  if (wantActive) {
    // Clean 400 instead of the DB trigger's raw exception text:
    // confirm the membership's own profile is still active before
    // reactivating. internal_team_members_validate_active enforces
    // this independently either way.
    const { data: current } = await ctx.supabase
      .from('internal_team_members')
      .select('user_id')
      .eq('id', memberId)
      .eq('team_id', teamId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })

    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('is_active')
      .eq('user_id', current.user_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!profile?.is_active) {
      return NextResponse.json({ error: 'Only active users can be reactivated as team members' }, { status: 400 })
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('internal_team_members')
    .update({ is_active: wantActive })
    .eq('id', memberId)
    .eq('team_id', teamId)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) {
    console.error('[internal-tickets/teams/[id]/members/[memberId]] PATCH failed:', sqlCode(error))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
  return NextResponse.json({ member: data })
}
