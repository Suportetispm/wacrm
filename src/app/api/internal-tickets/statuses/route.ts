import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// Internal ticket statuses (catalog) — GET lists (any account member,
// RLS-scoped); POST creates (admin/owner only). No DELETE handler —
// archiving is is_active=false, never a physical delete.
//
// is_default (HARDENING, migration 053 — fixes a real bug found in
// review): at most one true per account (DB partial unique index,
// migration 052) and a default must stay active (DB CHECK). The
// PREVIOUS version of this route unset the old default and inserted
// the new row as two independent Postgres round trips — a failure
// between them (e.g. a name collision on the insert) could leave the
// account with ZERO defaults, with no automatic recovery. Fixed by
// splitting into two steps that can NEVER produce that outcome:
//   1. INSERT the new row with is_default=FALSE, always — a plain
//      insert has no default-invariant risk at all, whatever else
//      goes wrong the OLD default is never touched by this step.
//   2. Only if is_default was actually requested, promote the new
//      row via set_internal_ticket_status_default() (053) — a single
//      SECURITY DEFINER transaction that unsets-and-sets atomically.
//      If step 2 fails, the row from step 1 still exists as a normal
//      (non-default) status and the OLD default is untouched — the
//      route returns a clear error either way; it never silently
//      hides the partial outcome.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_NAME_LEN = 120
const DEFAULT_COLOR = '#3b82f6'

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
      .from('internal_ticket_statuses')
      .select('*')
      .order('sort_order', { ascending: true })
    if (error) {
      console.error('[internal-tickets/statuses] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ statuses: data ?? [] })
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
  const color = typeof body.color === 'string' && body.color ? body.color : DEFAULT_COLOR
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : 0
  const isTerminal = Boolean(body.is_terminal)
  const isDefault = Boolean(body.is_default)

  // Step 1: always insert as non-default. See the file header comment
  // for why — this step alone can never touch the existing default.
  const { data: inserted, error: insertError } = await supabaseAdmin()
    .from('internal_ticket_statuses')
    .insert({
      account_id: ctx.accountId,
      name,
      color,
      sort_order: sortOrder,
      is_terminal: isTerminal,
      is_default: false,
    })
    .select()
    .single()

  if (insertError) {
    const code = sqlCode(insertError)
    console.error('[internal-tickets/statuses] POST insert failed:', code)
    if (code === '23505') {
      return NextResponse.json({ error: 'A status with this name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }

  // Step 2: only if the caller actually asked for is_default=true —
  // promote the just-created row via the atomic RPC (053). A failure
  // here leaves `inserted` in place as an ordinary, non-default status
  // and the previous default untouched. The row WAS created, so this
  // still responds 201 — but with a `warning` (never `error`, which
  // the client treats as "nothing happened" and skips refreshing the
  // list) so the caller sees the new row AND knows the promotion part
  // didn't take effect, never a silently swallowed partial outcome.
  if (isDefault) {
    const { data: promoted, error: rpcError } = await supabaseAdmin().rpc(
      'set_internal_ticket_status_default',
      { p_account_id: ctx.accountId, p_status_id: inserted.id },
    )
    if (rpcError) {
      const code = sqlCode(rpcError)
      console.error('[internal-tickets/statuses] POST promote-default failed:', code)
      return NextResponse.json(
        {
          status: inserted,
          warning:
            code === '23514'
              ? 'The status was created, but a default status must be active'
              : 'The status was created, but could not be set as default. It exists as a non-default status — try setting it as default again.',
        },
        { status: 201 },
      )
    }
    return NextResponse.json({ status: promoted }, { status: 201 })
  }

  return NextResponse.json({ status: inserted }, { status: 201 })
}
