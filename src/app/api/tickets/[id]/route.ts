import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

// GET one ticket + its event timeline. RLS-scoped on both tables
// (tickets_select / ticket_events_select) — no additional filtering
// needed here. Read-only: no PATCH/DELETE on this route (see
// migration 040's comment on why tickets has no client UPDATE
// policy — mutations are deferred to future SECURITY DEFINER
// functions, not implemented in this etapa).
//
// A ticket that doesn't exist and a ticket that exists but belongs to
// another account (or is outside this caller's RLS-narrowed view, e.g.
// an agent viewing a ticket from a queue they're not in) are
// deliberately indistinguishable here — RLS silently returns no row
// either way, and this route always answers 404, never 403.
// Answering 403 for "exists but not yours" would confirm the id is a
// real ticket in someone else's account — a real information leak.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message`. The sanitized Postgres code is logged
// server-side for diagnosis.

const GENERIC_ERROR = 'Failed to load ticket'

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
  try {
    const { supabase } = await getCurrentAccount()

    const { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (ticketError) {
      console.error('[tickets/[id]] GET failed:', sqlCode(ticketError))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    // 404 for both "doesn't exist" and "exists but not visible to
    // this caller" — see the file-level comment above.
    if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 })

    const [{ data: queue }, { data: conversation }, { data: events }] = await Promise.all([
      ticket.queue_id
        ? supabase.from('queues').select('id, name, color').eq('id', ticket.queue_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('conversations')
        .select('id, status, contact:contacts(id, name, phone)')
        .eq('id', ticket.conversation_id)
        .maybeSingle(),
      supabase
        .from('ticket_events')
        .select('*')
        .eq('ticket_id', id)
        .order('created_at', { ascending: false }),
    ])

    return NextResponse.json({
      ticket: {
        ...ticket,
        queue: queue ?? null,
        contact: conversation?.contact ?? null,
        // Same round trip as the contact join — `status` is one more
        // selected column, not an extra query. See GET /api/tickets
        // for why this is hydrated (5-state operational status).
        conversation_status: conversation?.status ?? null,
      },
      events: events ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
