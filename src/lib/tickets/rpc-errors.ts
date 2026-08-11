// ============================================================
// Maps the SQLSTATEs used by the ticket operational RPCs (see
// supabase/migrations/049_ticket_operations.sql — claim_ticket,
// transfer_ticket_queue, transfer_ticket_agent,
// mark_ticket_waiting_customer, resume_ticket, close_ticket, all six
// share the same 42501/22023/23505 contract) onto HTTP responses.
// Mirrors src/lib/platform/rpc-errors.ts's exact convention, applied
// here to the tenant-scoped (getCurrentAccount/RLS) side instead of
// the platform-admin side — same shape, deliberately not shared
// across the two, since they gate completely different authorization
// contexts (see src/lib/auth/platform-admin.ts's own header comment
// on why platform and tenant auth never mix).
// ============================================================

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

export function ticketRpcErrorToResponse(
  err: PostgrestError,
  fallbackMessage: string,
): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 })
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
  if (err.code === '23505') {
    return NextResponse.json({ error: err.message }, { status: 409 })
  }
  console.error('[ticket rpc] unexpected error:', err.code)
  return NextResponse.json({ error: fallbackMessage }, { status: 500 })
}
