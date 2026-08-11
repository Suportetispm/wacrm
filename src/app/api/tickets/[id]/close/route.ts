import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ticketRpcErrorToResponse } from '@/lib/tickets/rpc-errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// POST /api/tickets/[id]/close — "Encerrar"/"Finalizar". Thin wrapper
// over close_ticket() (migration 049). `finalize` is required (never
// defaulted here — always passed explicitly to the RPC, same
// discipline as every other RPC call in this codebase). `close_reason`
// only gets a shallow length pre-check; the RPC itself trims and
// treats an empty string as NULL — not duplicated here.

const MAX_CLOSE_REASON_LENGTH = 500

interface CloseTicketBody {
  finalize?: unknown
  close_reason?: unknown
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`ticket:action:${userId}`, RATE_LIMITS.ticketAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params

    const body = (await request.json().catch(() => null)) as CloseTicketBody | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    if (typeof body.finalize !== 'boolean') {
      return NextResponse.json({ error: "'finalize' must be a boolean" }, { status: 400 })
    }

    let closeReason: string | null = null
    if (body.close_reason !== undefined && body.close_reason !== null) {
      if (typeof body.close_reason !== 'string') {
        return NextResponse.json({ error: "'close_reason' must be a string" }, { status: 400 })
      }
      if (body.close_reason.length > MAX_CLOSE_REASON_LENGTH) {
        return NextResponse.json(
          { error: `'close_reason' must be ${MAX_CLOSE_REASON_LENGTH} characters or fewer` },
          { status: 400 },
        )
      }
      closeReason = body.close_reason
    }

    const { data, error } = await supabase.rpc('close_ticket', {
      p_ticket_id: id,
      p_close_reason: closeReason,
      p_finalize: body.finalize,
    })
    if (error) return ticketRpcErrorToResponse(error, 'Failed to close ticket')

    return NextResponse.json({ ticket: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
