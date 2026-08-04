import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/queues/admin-client'
import type { QueueMemberRole } from '@/types'

// PATCH updates role/weight/wait/cap/is_active for one membership row;
// DELETE removes it. Both admin/owner only, both scoped by account_id
// (and queue_id, from the route) so a caller can never touch another
// account's — or another queue's — membership row.
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const { id: queueId, memberId } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.role_in_queue === 'string') {
    if (!ROLES.includes(body.role_in_queue as QueueMemberRole)) {
      return NextResponse.json({ error: `role_in_queue must be one of: ${ROLES.join(', ')}` }, { status: 400 })
    }
    update.role_in_queue = body.role_in_queue
  }
  if (Number.isInteger(body.weight)) {
    update.weight = Math.min(100, Math.max(1, body.weight))
  }
  if ('individual_wait_minutes' in body) {
    update.individual_wait_minutes =
      body.individual_wait_minutes == null
        ? null
        : Number.isInteger(body.individual_wait_minutes)
          ? Math.min(60, Math.max(1, body.individual_wait_minutes))
          : null
  }
  if ('max_active_tickets' in body) {
    update.max_active_tickets =
      body.max_active_tickets == null
        ? null
        : Number.isInteger(body.max_active_tickets) && body.max_active_tickets > 0
          ? body.max_active_tickets
          : null
  }
  if ('is_active' in body) update.is_active = Boolean(body.is_active)

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('queue_members')
    .update(update)
    .eq('id', memberId)
    .eq('queue_id', queueId)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) {
    console.error('[queues/[id]/members/[memberId]] PATCH failed:', sqlCode(error))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
  return NextResponse.json({ member: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const { id: queueId, memberId } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data, error } = await supabaseAdmin()
    .from('queue_members')
    .delete()
    .eq('id', memberId)
    .eq('queue_id', queueId)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) {
    console.error('[queues/[id]/members/[memberId]] DELETE failed:', sqlCode(error))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
