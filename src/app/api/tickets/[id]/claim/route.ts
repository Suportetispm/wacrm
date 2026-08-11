import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// POST /api/tickets/[id]/claim — "Assumir atendimento". Thin wrapper
// over claim_ticket() (migration 049) — no body. The RPC is the sole
// authority: role/queue-membership/queue-active/already-assigned/
// concurrency are all enforced there, not duplicated here. Called via
// the RLS-scoped client (never service_role) — claim_ticket is
// SECURITY DEFINER and validates auth.uid() internally.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const { data, error } = await supabase.rpc('claim_ticket', { p_ticket_id: id })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to claim ticket')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
