import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// POST /api/tickets/[id]/waiting-customer — "Aguardar cliente". Thin
// wrapper over mark_ticket_waiting_customer() (migration 049) — no
// body. Only 'open' tickets with an assignee can transition; the RPC
// enforces this, not this route.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const { data, error } = await supabase.rpc('mark_ticket_waiting_customer', {
      p_ticket_id: id,
    })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to mark ticket as waiting on customer')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
