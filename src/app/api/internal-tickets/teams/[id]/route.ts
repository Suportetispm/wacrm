import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// GET one team (any member, RLS-scoped); PATCH edits name/sort_order/
// is_active — never a physical delete. Membership is managed via
// internal-tickets/teams/[id]/members, not here.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_NAME_LEN = 120

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
  const { id } = await params
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase.from('internal_teams').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error('[internal-tickets/teams/[id]] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    return NextResponse.json({ team: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }, { status: 400 })
    }
    update.name = name
  }
  if (Number.isInteger(body.sort_order)) update.sort_order = body.sort_order
  if ('is_active' in body) update.is_active = Boolean(body.is_active)

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('internal_teams')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/teams/[id]] PATCH failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A team with this name already exists' : GENERIC_ERROR }, { status })
  }
  if (!data) return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  return NextResponse.json({ team: data })
}
