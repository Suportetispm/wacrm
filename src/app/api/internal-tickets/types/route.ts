import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal ticket types (catalog) — GET lists (any account member,
// RLS-scoped read via the user client); POST creates (admin/owner
// only). Mirrors src/app/api/queues/route.ts. No DELETE handler on
// this route at all — internal_ticket_types has no DELETE RLS policy;
// archiving is is_active=false, never a physical delete.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message`. The sanitized Postgres code is logged
// server-side for diagnosis.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_NAME_LEN = 120
const MAX_DESCRIPTION_LEN = 2000

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
    // RLS (internal_ticket_types_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('internal_ticket_types')
      .select('*')
      .order('sort_order', { ascending: true })
    if (error) {
      console.error('[internal-tickets/types] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ types: data ?? [] })
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
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (description.length > MAX_DESCRIPTION_LEN) {
    return NextResponse.json({ error: `description must be ${MAX_DESCRIPTION_LEN} characters or fewer` }, { status: 400 })
  }
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : 0

  // account_id is always the session's, never the client's — same
  // discipline as every other account-scoped insert in this codebase.
  const { data, error } = await supabaseAdmin()
    .from('internal_ticket_types')
    .insert({
      account_id: ctx.accountId,
      name,
      description: description || null,
      sort_order: sortOrder,
    })
    .select()
    .single()

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/types] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A type with this name already exists' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ type: data }, { status: 201 })
}
