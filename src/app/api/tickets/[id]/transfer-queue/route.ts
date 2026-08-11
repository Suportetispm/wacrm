import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isUuid } from '@/lib/uuid'

// POST /api/tickets/[id]/transfer-queue — "Transferir fila". Thin
// wrapper over transfer_ticket_queue() (migration 049). Only checks
// that `queue_id` is present and UUID-shaped — cross-tenant,
// active-queue, same-queue-no-op, and access-permission checks are
// all the RPC's job, not duplicated here.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const body = (await request.json().catch(() => null)) as { queue_id?: unknown } | null
    const queueId = typeof body?.queue_id === 'string' ? body.queue_id.trim() : ''
    if (!queueId) {
      return NextResponse.json({ error: "'queue_id' is required" }, { status: 400 })
    }
    if (!isUuid(queueId)) {
      return NextResponse.json({ error: "'queue_id' must be a valid UUID" }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('transfer_ticket_queue', {
      p_ticket_id: id,
      p_queue_id: queueId,
    })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to transfer ticket to queue')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
