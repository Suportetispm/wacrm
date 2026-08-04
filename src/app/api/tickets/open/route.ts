import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/queues/admin-client'
import type { Ticket, TicketPriority } from '@/types'

// POST /api/tickets/open — the only sanctioned way to open a ticket
// from the interface. admin-only in this first version (per etapa
// 9.3 item 6). accountId always comes from the session
// (requireRole), never the request body. Calls
// public.open_ticket_for_conversation via the service-role client —
// that RPC's EXECUTE grant is service_role only, so an authenticated
// session (any role) cannot invoke it directly even if it tried.

const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']

function isWellFormedTicket(value: unknown): value is Ticket {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.ticket_number === 'number' &&
    typeof v.status === 'string' &&
    typeof v.conversation_id === 'string'
  )
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

  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
  if (!conversationId) {
    return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
  }
  const queueId: string | null = typeof body.queue_id === 'string' && body.queue_id ? body.queue_id : null
  const priority: TicketPriority = PRIORITIES.includes(body.priority) ? body.priority : 'normal'

  // Defense in depth: confirm conversation_id/queue_id actually belong
  // to this account via the RLS-scoped client BEFORE calling the RPC
  // (which re-validates independently anyway — the RPC's own tenancy
  // check and the tickets_validate_tenancy trigger do not depend on
  // this route having done so). A clean 400 here is better UX than
  // surfacing the RPC's own exception text.
  const { data: conversation } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!conversation) {
    return NextResponse.json({ error: 'conversation_id must belong to this account' }, { status: 400 })
  }

  if (queueId) {
    const { data: queue } = await ctx.supabase
      .from('queues')
      .select('id')
      .eq('id', queueId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!queue) {
      return NextResponse.json({ error: 'queue_id must belong to this account' }, { status: 400 })
    }
  }

  const { data, error } = await supabaseAdmin().rpc('open_ticket_for_conversation', {
    p_account_id: ctx.accountId,
    p_conversation_id: conversationId,
    p_queue_id: queueId,
    p_priority: priority,
    p_actor_user_id: ctx.userId,
  })

  if (error) {
    // Never surface the raw DB error message (may embed internals) —
    // only a generic failure.
    console.error('[tickets/open] open_ticket_for_conversation failed:', (error as { code?: string }).code)
    return NextResponse.json({ error: 'Failed to open ticket' }, { status: 502 })
  }

  // RETURNS tickets means `data` is a single JSON object, not an
  // array (see migration 040's comment on the function) — never
  // assume an unexpected shape means success.
  if (!isWellFormedTicket(data)) {
    console.error('[tickets/open] unexpected RPC return shape')
    return NextResponse.json({ error: 'Failed to open ticket' }, { status: 502 })
  }

  return NextResponse.json({ ticket: data }, { status: 201 })
}
