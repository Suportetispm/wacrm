import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// POST /api/tickets/[id]/resume — "Retomar atendimento". Thin
// wrapper over resume_ticket() (migration 049) — no body. Only a
// 'pending' ticket can resume; the RPC enforces this, not this route.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const { data, error } = await supabase.rpc('resume_ticket', { p_ticket_id: id })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to resume ticket')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
