import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'
import { isUuid } from '@/lib/uuid'

// GET ticket + its event timeline (RLS-scoped — same involvement rule
// as the list route); PATCH edits allowed fields via the
// update_internal_ticket RPC (054) — NEVER a raw UPDATE on
// internal_tickets. The RPC re-derives authorization internally
// (actor active, role, USING/WITH CHECK-equivalent involvement for
// agent) — this route's requireRole('agent') is the first gate, not
// the only one.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_TITLE_LEN = 120
const PATCHABLE_KEYS = [
  'title', 'description', 'type_id', 'status_id', 'stage_id',
  'team_id', 'internal_company_id', 'assigned_user_id',
] as const

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
  if (!isUuid(id)) return NextResponse.json({ error: 'Internal ticket not found' }, { status: 404 })

  try {
    const { supabase } = await getCurrentAccount()
    const { data: ticket, error } = await supabase
      .from('internal_tickets')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      console.error('[internal-tickets/[id]] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    // Not found and "exists but RLS hides it" collapse to the same
    // 404 — same convention as the rest of this module (never an
    // existence oracle).
    if (!ticket) return NextResponse.json({ error: 'Internal ticket not found' }, { status: 404 })

    const { data: events, error: eventsError } = await supabase
      .from('internal_ticket_events')
      .select('*')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true })

    if (eventsError) {
      console.error('[internal-tickets/[id]] events GET failed:', sqlCode(eventsError))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }

    return NextResponse.json({ ticket, events: events ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Internal ticket not found' }, { status: 404 })

  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const changes: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (!(PATCHABLE_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json({ error: `Unknown field: ${key}` }, { status: 400 })
    }
  }
  for (const key of PATCHABLE_KEYS) {
    if (!(key in body)) continue
    const value = (body as Record<string, unknown>)[key]

    if (key === 'title') {
      if (typeof value !== 'string' || !value.trim()) {
        return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
      }
      if (value.trim().length > MAX_TITLE_LEN) {
        return NextResponse.json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer` }, { status: 400 })
      }
      changes.title = value.trim()
      continue
    }
    if (key === 'description') {
      if (value !== null && typeof value !== 'string') {
        return NextResponse.json({ error: "'description' must be a string or null" }, { status: 400 })
      }
      changes.description = typeof value === 'string' && value.trim() ? value.trim() : null
      continue
    }
    // The 6 remaining keys are all UUID FKs — type_id/status_id are
    // required (null rejected by the RPC itself, ERRCODE 22023);
    // stage_id/team_id/internal_company_id/assigned_user_id accept
    // null to clear the field.
    if (value === null) {
      changes[key] = null
      continue
    }
    if (!isUuid(value)) {
      return NextResponse.json({ error: `'${key}' must be a valid UUID or null` }, { status: 400 })
    }
    changes[key] = value
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin().rpc('update_internal_ticket', {
    p_account_id: ctx.accountId,
    p_actor_user_id: ctx.userId,
    p_ticket_id: id,
    p_changes: changes,
  })

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/[id]] PATCH failed:', code)
    if (code === 'P0002') return NextResponse.json({ error: 'Internal ticket not found' }, { status: 404 })
    if (code === '42501') return NextResponse.json({ error: 'You are not allowed to make this change' }, { status: 403 })
    if (code === '22023') return NextResponse.json({ error: 'Invalid ticket data' }, { status: 400 })
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  return NextResponse.json({ ticket: data })
}
