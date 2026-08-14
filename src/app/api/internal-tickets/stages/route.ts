import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal ticket stages (catalog) — GET lists (any account member,
// RLS-scoped); POST creates (admin/owner only). No DELETE handler —
// archiving is is_active=false, never a physical delete.
//
// is_default (HARDENING, migration 053): same fix and reasoning as
// internal-tickets/statuses/route.ts — see that file's header comment
// for the full bug writeup. Stages just lack a `color` field.

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
    const { data, error } = await supabase
      .from('internal_ticket_stages')
      .select('*')
      .order('sort_order', { ascending: true })
    if (error) {
      console.error('[internal-tickets/stages] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ stages: data ?? [] })
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
  const isTerminal = Boolean(body.is_terminal)
  const isDefault = Boolean(body.is_default)

  // Step 1: always insert as non-default — see statuses/route.ts for
  // why. This step alone can never touch the existing default.
  const { data: inserted, error: insertError } = await supabaseAdmin()
    .from('internal_ticket_stages')
    .insert({
      account_id: ctx.accountId,
      name,
      sort_order: sortOrder,
      is_terminal: isTerminal,
      is_default: false,
    })
    .select()
    .single()

  if (insertError) {
    const code = sqlCode(insertError)
    console.error('[internal-tickets/stages] POST insert failed:', code)
    if (code === '23505') {
      return NextResponse.json({ error: 'A stage with this name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }

  // Step 2: only if requested — promote via the atomic RPC (053). A
  // failure here leaves `inserted` as an ordinary, non-default stage
  // and the previous default untouched.
  if (isDefault) {
    const { data: promoted, error: rpcError } = await supabaseAdmin().rpc(
      'set_internal_ticket_stage_default',
      { p_account_id: ctx.accountId, p_stage_id: inserted.id },
    )
    if (rpcError) {
      const code = sqlCode(rpcError)
      console.error('[internal-tickets/stages] POST promote-default failed:', code)
      return NextResponse.json(
        {
          stage: inserted,
          warning:
            code === '23514'
              ? 'The stage was created, but a default stage must be active'
              : 'The stage was created, but could not be set as default. It exists as a non-default stage — try setting it as default again.',
        },
        { status: 201 },
      )
    }
    return NextResponse.json({ stage: promoted }, { status: 201 })
  }

  return NextResponse.json({ stage: inserted }, { status: 201 })
}
