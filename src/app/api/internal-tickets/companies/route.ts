import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal companies (catalog) — GET lists (any account member,
// RLS-scoped); POST creates (admin/owner only). Same shape/pattern as
// internal-tickets/types. `internal_companies` is NOT `accounts` — it's
// an account-scoped catalog of companies/units related to internal
// tickets (migration 052, section 1.5). No DELETE handler on this
// route — archiving is is_active=false, never a physical delete.

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
    const { data, error } = await supabase
      .from('internal_companies')
      .select('*')
      .order('sort_order', { ascending: true })
    if (error) {
      console.error('[internal-tickets/companies] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ companies: data ?? [] })
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

  const { data, error } = await supabaseAdmin()
    .from('internal_companies')
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
    console.error('[internal-tickets/companies] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A company with this name already exists' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ company: data }, { status: 201 })
}
