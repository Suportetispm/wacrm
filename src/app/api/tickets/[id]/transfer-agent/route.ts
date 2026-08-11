import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isUuid } from '@/lib/uuid'

// POST /api/tickets/[id]/transfer-agent — "Transferir atendente".
// Thin wrapper over transfer_ticket_agent() (migration 049). Only
// checks that `agent_user_id` is present and UUID-shaped — target
// role/active/queue-membership/same-agent-no-op/permission checks
// are all the RPC's job, not duplicated here.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const body = (await request.json().catch(() => null)) as { agent_user_id?: unknown } | null
    const agentUserId = typeof body?.agent_user_id === 'string' ? body.agent_user_id.trim() : ''
    if (!agentUserId) {
      return NextResponse.json({ error: "'agent_user_id' is required" }, { status: 400 })
    }
    if (!isUuid(agentUserId)) {
      return NextResponse.json({ error: "'agent_user_id' must be a valid UUID" }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('transfer_ticket_agent', {
      p_ticket_id: id,
      p_agent_user_id: agentUserId,
    })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to transfer ticket to agent')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
