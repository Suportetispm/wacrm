import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'

// GET one stage (any member, RLS-scoped); PATCH edits fields — never
// a physical delete.
//
// is_default (HARDENING, migration 053): same fix and reasoning as
// internal-tickets/statuses/[id]/route.ts — see that file's header
// comment for the full writeup. Promotion always goes through
// set_internal_ticket_stage_default() (053), runs FIRST, before any
// other requested field change.
//
// is_default=false (HARDENING, second pass): a bare `{ is_default:
// false }` PATCH must NEVER be able to clear an EXISTING default —
// no atomic replacement, zero defaults left. No-op if the row already
// isn't the default; rejected if it is. The only sanctioned way to
// change which row is default is promoting a DIFFERENT one through
// the RPC above.

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
    const { data, error } = await supabase.from('internal_ticket_stages').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error('[internal-tickets/stages/[id]] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
    return NextResponse.json({ stage: data })
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
  if ('is_terminal' in body) update.is_terminal = Boolean(body.is_terminal)

  const settingInactive = 'is_active' in body && !body.is_active
  const clearingDefault = 'is_default' in body && !body.is_default
  if (settingInactive) update.is_active = false
  else if ('is_active' in body) update.is_active = true

  let promoteToDefault = false
  if ('is_default' in body) {
    const wantDefault = Boolean(body.is_default)
    if (wantDefault) {
      if (settingInactive) {
        return NextResponse.json({ error: 'A default stage must remain active' }, { status: 400 })
      }
      promoteToDefault = true
    } else {
      // Explicitly clearing is_default: only ever a no-op. Directly
      // removing an EXISTING default (with or without also touching
      // is_active in the same payload) is rejected — see file header.
      const { data: current } = await ctx.supabase
        .from('internal_ticket_stages')
        .select('is_default')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (current?.is_default) {
        return NextResponse.json(
          { error: 'Cannot remove the default directly — promote a different stage to default instead' },
          { status: 400 },
        )
      }
      update.is_default = false
    }
  } else if (settingInactive && !clearingDefault) {
    const { data: current } = await ctx.supabase
      .from('internal_ticket_stages')
      .select('is_default')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (current?.is_default) {
      return NextResponse.json(
        { error: 'Cannot deactivate the default stage — set another stage as default first' },
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
      'set_internal_ticket_stage_default',
      { p_account_id: ctx.accountId, p_stage_id: id },
    )
    if (rpcError) {
      const code = sqlCode(rpcError)
      console.error('[internal-tickets/stages/[id]] PATCH promote-default failed:', code)
      if (code === 'P0002') return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
      if (code === '23514') return NextResponse.json({ error: 'A default stage must remain active' }, { status: 400 })
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    finalRow = promoted
  }

  if (Object.keys(update).length > 0) {
    const { data, error } = await supabaseAdmin()
      .from('internal_ticket_stages')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select()
      .maybeSingle()

    if (error || !data) {
      if (error) console.error('[internal-tickets/stages/[id]] PATCH field-update failed:', sqlCode(error))
      if (promoteToDefault) {
        // The promotion above already committed in its own
        // transaction and is NOT undone here — report the true,
        // partial outcome instead of a plain error that would imply
        // nothing happened at all.
        return NextResponse.json(
          { stage: finalRow, warning: 'The stage is now the default, but the other changes could not be saved.' },
          { status: 200 },
        )
      }
      const code = sqlCode(error)
      if (code === '23505') {
        return NextResponse.json({ error: 'A stage with this name already exists' }, { status: 409 })
      }
      if (code === '23514') {
        return NextResponse.json({ error: 'A default stage must remain active' }, { status: 400 })
      }
      if (!error) return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    finalRow = data
  }

  return NextResponse.json({ stage: finalRow })
}
