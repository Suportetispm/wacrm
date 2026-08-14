import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'
import { isUuid } from '@/lib/uuid'

// Internal tickets (052-INT-C) — GET lists (RLS-scoped: admin/owner
// see every ticket in the account, agent/viewer only ones they're
// involved in, per internal_tickets_select from migration 052). POST
// creates via the create_internal_ticket RPC (054) — never a raw
// INSERT, since internal_tickets has no INSERT RLS policy and the
// RPC is the only atomic path (code allocation + ticket + 'created'
// event in one transaction).
//
// p_account_id/p_actor_user_id are ALWAYS ctx.accountId/ctx.userId —
// never taken from the request body, regardless of what a caller
// sends.

const GENERIC_ERROR = 'Failed to process the request'
const MAX_TITLE_LEN = 120
const MAX_RESULTS = 200

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

/** UUID query param: null when absent, the value when a valid UUID,
 *  or 'invalid' when present but malformed — lets callers 400 on the
 *  last case instead of silently dropping a typo'd filter. */
function uuidParam(url: URL, name: string): string | null | 'invalid' {
  const raw = url.searchParams.get(name)
  if (!raw) return null
  return isUuid(raw) ? raw : 'invalid'
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const url = new URL(request.url)

    let query = supabase.from('internal_tickets').select('*')

    const filters: [string, string][] = [
      ['type_id', 'type_id'],
      ['status_id', 'status_id'],
      ['stage_id', 'stage_id'],
      ['team_id', 'team_id'],
      ['internal_company_id', 'internal_company_id'],
      ['assigned_user_id', 'assigned_user_id'],
    ]
    for (const [param, column] of filters) {
      const value = uuidParam(url, param)
      if (value === 'invalid') {
        return NextResponse.json({ error: `'${param}' must be a valid UUID` }, { status: 400 })
      }
      if (value) query = query.eq(column, value)
    }

    const q = url.searchParams.get('q')?.trim()
    if (q) {
      // Numeric query = exact internal_code match, OR'd with a title
      // search so "42" still finds a title containing "42". Commas/
      // parens stripped — those are PostgREST .or() syntax
      // delimiters, not something a free-text search box should be
      // able to inject into the filter structure.
      const escaped = q.replace(/[,()]/g, '')
      if (/^\d+$/.test(q)) {
        query = query.or(`internal_code.eq.${q},title.ilike.%${escaped}%`)
      } else {
        query = query.ilike('title', `%${escaped}%`)
      }
    }

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(MAX_RESULTS)

    if (error) {
      console.error('[internal-tickets] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ tickets: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })
  if (title.length > MAX_TITLE_LEN) {
    return NextResponse.json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer` }, { status: 400 })
  }
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null

  if (!isUuid(body.type_id)) {
    return NextResponse.json({ error: "'type_id' is required and must be a valid UUID" }, { status: 400 })
  }

  // Optional FKs: absent/empty -> null (let the RPC resolve
  // status/stage defaults, leave team/company/assignee unset);
  // present but malformed -> 400, never silently dropped.
  const optionalFields: [string, unknown][] = [
    ['status_id', body.status_id],
    ['stage_id', body.stage_id],
    ['team_id', body.team_id],
    ['internal_company_id', body.internal_company_id],
    ['assigned_user_id', body.assigned_user_id],
  ]
  const resolved: Record<string, string | null> = {}
  for (const [key, value] of optionalFields) {
    if (value === undefined || value === null || value === '') {
      resolved[key] = null
      continue
    }
    if (!isUuid(value)) {
      return NextResponse.json({ error: `'${key}' must be a valid UUID` }, { status: 400 })
    }
    resolved[key] = value
  }

  const { data, error } = await supabaseAdmin().rpc('create_internal_ticket', {
    p_account_id: ctx.accountId,
    p_actor_user_id: ctx.userId,
    p_title: title,
    p_description: description,
    p_type_id: body.type_id,
    p_status_id: resolved.status_id,
    p_stage_id: resolved.stage_id,
    p_team_id: resolved.team_id,
    p_internal_company_id: resolved.internal_company_id,
    p_assigned_user_id: resolved.assigned_user_id,
  })

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets] POST failed:', code)
    if (code === '42501') return NextResponse.json({ error: 'You are not allowed to create internal tickets' }, { status: 403 })
    if (code === '22023') return NextResponse.json({ error: 'Invalid ticket data' }, { status: 400 })
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  return NextResponse.json({ ticket: data }, { status: 201 })
}
