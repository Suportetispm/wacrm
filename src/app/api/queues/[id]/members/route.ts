import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/queues/admin-client'
import type { QueueMemberRole } from '@/types'

// Queue members — GET lists (any account member, RLS-scoped);
// POST adds a member (admin/owner only). Two round trips instead of
// a PostgREST embed for the profile display fields: queue_members'
// FK to profiles is composite ((user_id, account_id), added purely
// for the tenancy guarantee in migration 039) rather than the simple
// single-column FK PostgREST's `select=*,profiles(*)` embedding
// reliably infers — a plain second query avoids depending on that.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message`. The sanitized Postgres code is logged
// server-side for diagnosis.

const ROLES: readonly QueueMemberRole[] = ['agent', 'supervisor']
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
  const { id: queueId } = await params
  try {
    const { supabase } = await getCurrentAccount()
    const { data: members, error } = await supabase
      .from('queue_members')
      .select('*')
      .eq('queue_id', queueId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[queues/[id]/members] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!members || members.length === 0) return NextResponse.json({ members: [] })

    const userIds = members.map((m) => m.user_id)
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, full_name, email, avatar_url')
      .in('user_id', userIds)
    const byUserId = new Map((profiles ?? []).map((p) => [p.user_id, p]))

    return NextResponse.json({
      members: members.map((m) => ({ ...m, profile: byUserId.get(m.user_id) ?? null })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: queueId } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!userId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })

  // Clean 400s instead of raw composite-FK-violation 500s: confirm
  // both the target queue and the target user's profile are actually
  // in THIS account before attempting the insert. The DB still
  // enforces both independently either way.
  const { data: targetQueue } = await ctx.supabase
    .from('queues')
    .select('id')
    .eq('id', queueId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!targetQueue) {
    return NextResponse.json({ error: 'Queue not found in this account' }, { status: 404 })
  }

  const { data: targetProfile } = await ctx.supabase
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!targetProfile) {
    return NextResponse.json({ error: 'user_id must belong to a profile in this account' }, { status: 400 })
  }

  const roleInQueue: QueueMemberRole = ROLES.includes(body.role_in_queue) ? body.role_in_queue : 'agent'
  const weight = Number.isInteger(body.weight) ? Math.min(100, Math.max(1, body.weight)) : 1
  const individualWaitMinutes =
    body.individual_wait_minutes == null
      ? null
      : Number.isInteger(body.individual_wait_minutes)
        ? Math.min(60, Math.max(1, body.individual_wait_minutes))
        : null
  const maxActiveTickets =
    body.max_active_tickets == null
      ? null
      : Number.isInteger(body.max_active_tickets) && body.max_active_tickets > 0
        ? body.max_active_tickets
        : null

  const { data, error } = await supabaseAdmin()
    .from('queue_members')
    .insert({
      account_id: ctx.accountId,
      queue_id: queueId,
      user_id: userId,
      role_in_queue: roleInQueue,
      weight,
      individual_wait_minutes: individualWaitMinutes,
      max_active_tickets: maxActiveTickets,
    })
    .select()
    .single()

  if (error) {
    const code = sqlCode(error)
    console.error('[queues/[id]/members] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'This user is already a member of the queue' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ member: data }, { status: 201 })
}
