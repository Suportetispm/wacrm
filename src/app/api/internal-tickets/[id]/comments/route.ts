import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/internal-tickets/admin-client'
import { isUuid } from '@/lib/uuid'

// GET lists comments (RLS-scoped — internal_ticket_comments_select
// mirrors the parent ticket's visibility); POST creates via the
// add_internal_ticket_comment RPC (054) — comment + 'comment_added'
// event in one transaction, never two separate writes.
//
// Out of scope for this phase (per 052-INT-C spec): editing or
// soft-deleting a comment. The DB-level infrastructure already exists
// (deleted_at/deleted_by, RLS UPDATE policy for author-or-admin) but
// no route is wired to it yet.

const GENERIC_ERROR = 'Failed to process the request'

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
    const { data, error } = await supabase
      .from('internal_ticket_comments')
      .select('*')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[internal-tickets/[id]/comments] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ comments: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
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
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const bodyText = typeof body.body === 'string' ? body.body : ''
  if (!bodyText.trim()) return NextResponse.json({ error: 'body is required' }, { status: 400 })

  const { data, error } = await supabaseAdmin().rpc('add_internal_ticket_comment', {
    p_account_id: ctx.accountId,
    p_actor_user_id: ctx.userId,
    p_ticket_id: id,
    p_body: bodyText,
  })

  if (error) {
    const code = sqlCode(error)
    console.error('[internal-tickets/[id]/comments] POST failed:', code)
    if (code === 'P0002') return NextResponse.json({ error: 'Internal ticket not found' }, { status: 404 })
    if (code === '42501') return NextResponse.json({ error: 'You are not allowed to comment on this ticket' }, { status: 403 })
    if (code === '22023') return NextResponse.json({ error: 'Comment body cannot be empty' }, { status: 400 })
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  return NextResponse.json({ comment: data }, { status: 201 })
}
