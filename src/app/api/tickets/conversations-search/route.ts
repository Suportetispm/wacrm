import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

// GET /api/tickets/conversations-search?q=... — finds conversations by
// contact name/phone, for the "open a ticket" picker. RLS-scoped
// (contacts/conversations select policies already gate by account
// membership); returns at most 20 hits, no ticket status filtering —
// this is intentionally about conversations, not existing tickets.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message`. The sanitized Postgres code is logged
// server-side for diagnosis.

const GENERIC_ERROR = 'Search failed'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    if (!q) return NextResponse.json({ conversations: [] })

    const escaped = q.replace(/[,()]/g, '')
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id')
      .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
      .limit(20)
    if (contactsError) {
      console.error('[tickets/conversations-search] contacts lookup failed:', sqlCode(contactsError))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!contacts || contacts.length === 0) return NextResponse.json({ conversations: [] })

    const { data: conversations, error: convError } = await supabase
      .from('conversations')
      .select('id, contact:contacts(id, name, phone)')
      .in('contact_id', contacts.map((c) => c.id))
      .limit(20)
    if (convError) {
      console.error('[tickets/conversations-search] conversations lookup failed:', sqlCode(convError))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }

    return NextResponse.json({ conversations: conversations ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
