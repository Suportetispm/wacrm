import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal teams (catalog) — GET lists (any account member,
// RLS-scoped), hydrated with each team's active member count. POST
// creates (admin/owner only). No DELETE handler — archiving is
// is_active=false, never a physical delete. `internal_teams` is
// exclusive to the Internal Tickets module — never `queues`.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_NAME_LEN = 120

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data: teams, error } = await supabase
      .from('internal_teams')
      .select('*')
      .order('sort_order', { ascending: true })
    if (error) {
      console.error('[internal-tickets/teams] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!teams || teams.length === 0) return NextResponse.json({ teams: [] })

    // Second round trip for active member counts — kept separate from
    // the teams query itself (no PostgREST embed) for the same reason
    // queue rosters do a second query for profiles: keeps this route
    // simple and independent of relationship-cache behavior.
    const { data: memberRows } = await supabase
      .from('internal_team_members')
      .select('team_id')
      .in('team_id', teams.map((t) => t.id))
      .eq('is_active', true)
    const counts = new Map<string, number>()
    for (const row of memberRows ?? []) {
      counts.set(row.team_id, (counts.get(row.team_id) ?? 0) + 1)
    }

    return NextResponse.json({
      teams: teams.map((t) => ({ ...t, active_member_count: counts.get(t.id) ?? 0 })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }, { status: 400 })
  }
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : 0

  const { data, error } = await supabaseAdmin()
    .from('internal_teams')
    .insert({
      account_id: ctx.accountId,
      name,
      sort_order: sortOrder,
    })
    .select()
    .single()

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/teams] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A team with this name already exists' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ team: { ...data, active_member_count: 0 } }, { status: 201 })
}
