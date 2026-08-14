import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// GET one status (any member, RLS-scoped); PATCH edits fields —
// never a physical delete.
//
// is_default (HARDENING, migration 053 — see route.ts/POST for the
// full bug writeup): promotion to default ALWAYS goes through
// set_internal_ticket_status_default() (053), never a manual
// unset-then-update pair. The RPC call happens FIRST, before any of
// the other requested field changes (name/color/sort_order/
// is_terminal/is_active) are applied — deliberately, so a PATCH like
// `{ name: "...", is_default: true }` can never end up "renamed but
// silently not promoted": if the promotion fails, this route stops
// immediately and touches nothing else. If the promotion succeeds
// but the OTHER fields then fail to save, that's reported back as a
// `warning` (not `error`) alongside the now-current row — the
// promotion already committed in its own transaction and is not
// undone; the caller is told exactly what did and didn't happen.
//
// is_default=false (HARDENING, second pass): a bare `{ is_default:
// false }` PATCH must NEVER be able to clear an EXISTING default —
// that would leave the account with zero defaults, with no atomic
// replacement, exactly the invariant this whole migration exists to
// protect. Removing "false" from a row that already isn't the
// default is a harmless no-op; removing it from the row that IS the
// current default is rejected outright. The only sanctioned way to
// change which row is default is promoting a DIFFERENT one through
// the RPC above (which atomically clears this one as part of that
// same transaction).

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
    const { data, error } = await supabase.from('internal_ticket_statuses').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error('[internal-tickets/statuses/[id]] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Status not found' }, { status: 404 })
    return NextResponse.json({ status: data })
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
  if (typeof body.color === 'string' && body.color) update.color = body.color
  if (Number.isInteger(body.sort_order)) update.sort_order = body.sort_order
  if ('is_terminal' in body) update.is_terminal = Boolean(body.is_terminal)

  const settingInactive = 'is_active' in body && !body.is_active
  const clearingDefault = 'is_default' in body && !body.is_default
  if (settingInactive) update.is_active = false
  else if ('is_active' in body) update.is_active = true

  let promoteToDefault = false
  if ('is_default' in body) {
    const wantDefault = Boolean(body.is_default)
    if (wantDefault) {
      // Clean 400 pre-check instead of relying only on the CHECK
      // constraint: a default cannot be inactive. If this same request
      // is also setting is_active=false, that's a self-contradictory
      // payload — reject before touching the DB at all.
      if (settingInactive) {
        return NextResponse.json({ error: 'A default status must remain active' }, { status: 400 })
      }
      promoteToDefault = true
    } else {
      // Explicitly clearing is_default: only ever a no-op. Directly
      // removing an EXISTING default (with or without also touching
      // is_active in the same payload) is rejected — see file header.
      const { data: current } = await ctx.supabase
        .from('internal_ticket_statuses')
        .select('is_default')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (current?.is_default) {
        return NextResponse.json(
          { error: 'Cannot remove the default directly — promote a different status to default instead' },
          { status: 400 },
        )
      }
      update.is_default = false
    }
  } else if (settingInactive && !clearingDefault) {
    // Deactivating without touching is_default in the same request:
    // block if this row IS the current default, with a clean message
    // instead of the DB CHECK's raw exception text. The DB CHECK
    // (NOT is_default OR is_active) still enforces this independently
    // either way.
    const { data: current } = await ctx.supabase
      .from('internal_ticket_statuses')
      .select('is_default')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (current?.is_default) {
      return NextResponse.json(
        { error: 'Cannot deactivate the default status — set another status as default first' },
        { status: 409 },
      )
    }
  }

  if (!promoteToDefault && Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  let finalRow: Record<string, unknown> | null = null

  // Promotion runs FIRST, deliberately (see file header) — if it
  // fails, we return immediately without touching `update` at all.
  if (promoteToDefault) {
    const { data: promoted, error: rpcError } = await supabaseAdmin().rpc(
      'set_internal_ticket_status_default',
      { p_account_id: ctx.accountId, p_status_id: id },
    )
    if (rpcError) {
      const code = sqlCode(rpcError)
      console.error('[internal-tickets/statuses/[id]] PATCH promote-default failed:', code)
      if (code === 'P0002') return NextResponse.json({ error: 'Status not found' }, { status: 404 })
      if (code === '23514') return NextResponse.json({ error: 'A default status must remain active' }, { status: 400 })
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    finalRow = promoted
  }

  if (Object.keys(update).length > 0) {
    const { data, error } = await supabaseAdmin()
      .from('internal_ticket_statuses')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select()
      .maybeSingle()

    if (error || !data) {
      if (error) console.error('[internal-tickets/statuses/[id]] PATCH field-update failed:', sqlCode(error))
      if (promoteToDefault) {
        // The promotion above already committed in its own
        // transaction and is NOT undone here — report the true,
        // partial outcome instead of a plain error that would imply
        // nothing happened at all.
        return NextResponse.json(
          { status: finalRow, warning: 'The status is now the default, but the other changes could not be saved.' },
          { status: 200 },
        )
      }
      const code = sqlCode(error)
      if (code === '23505') {
        return NextResponse.json({ error: 'A status with this name already exists' }, { status: 409 })
      }
      if (code === '23514') {
        return NextResponse.json({ error: 'A default status must remain active' }, { status: 400 })
      }
      if (!error) return NextResponse.json({ error: 'Status not found' }, { status: 404 })
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    finalRow = data
  }

  return NextResponse.json({ status: finalRow })
}
