import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { isUuid } from '@/lib/uuid'
import type { TicketPriority, TicketStatus } from '@/types'

// GET /api/tickets — list with filters. RLS-scoped (tickets_select):
// owner/admin/viewer see every ticket in the account, agent sees only
// what's assigned to them or in a queue they belong to — this route
// does not additionally restrict anything, it just passes filters
// through to a query the DB already scopes correctly.

const STATUSES: readonly TicketStatus[] = ['open', 'pending', 'closed']
const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const GENERIC_ERROR = 'Failed to load tickets'

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

    const status = url.searchParams.get('status')
    const queueId = url.searchParams.get('queue_id')
    const assignedAgentId = url.searchParams.get('assigned_agent_id')
    const conversationId = url.searchParams.get('conversation_id')
    const priority = url.searchParams.get('priority')
    const q = url.searchParams.get('q')?.trim() ?? ''
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(url.searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE),
    )

    let query = supabase.from('tickets').select('*', { count: 'exact' })

    if (status) {
      if (!STATUSES.includes(status as TicketStatus)) {
        return NextResponse.json({ error: `status must be one of: ${STATUSES.join(', ')}` }, { status: 400 })
      }
      query = query.eq('status', status)
    }
    if (queueId) {
      if (!isUuid(queueId)) {
        return NextResponse.json({ error: "'queue_id' must be a valid UUID" }, { status: 400 })
      }
      query = query.eq('queue_id', queueId)
    }
    if (assignedAgentId) {
      if (!isUuid(assignedAgentId)) {
        return NextResponse.json({ error: "'assigned_agent_id' must be a valid UUID" }, { status: 400 })
      }
      query = query.eq('assigned_agent_id', assignedAgentId)
    }
    // Lets a caller (the future Inbox badge, per 6E.1) ask "does this
    // conversation have a ticket right now?" without a dedicated
    // endpoint — combines with every other filter above via AND, same
    // as they already combine with each other.
    if (conversationId) {
      if (!isUuid(conversationId)) {
        return NextResponse.json({ error: "'conversation_id' must be a valid UUID" }, { status: 400 })
      }
      query = query.eq('conversation_id', conversationId)
    }
    if (priority) {
      if (!PRIORITIES.includes(priority as TicketPriority)) {
        return NextResponse.json({ error: `priority must be one of: ${PRIORITIES.join(', ')}` }, { status: 400 })
      }
      query = query.eq('priority', priority)
    }

    // Numeric query = exact ticket_number match. Otherwise, resolve to
    // a set of conversation ids via a contact name/phone search, then
    // filter tickets by conversation_id — tickets carries no searchable
    // text of its own.
    if (q) {
      const asNumber = Number(q)
      if (Number.isInteger(asNumber) && String(asNumber) === q) {
        query = query.eq('ticket_number', asNumber)
      } else {
        const escaped = q.replace(/[,()]/g, '')
        const { data: contacts } = await supabase
          .from('contacts')
          .select('id')
          .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
          .limit(200)
        const contactIds = (contacts ?? []).map((c) => c.id)
        if (contactIds.length === 0) {
          return NextResponse.json({ tickets: [], total: 0, page, pageSize })
        }
        const { data: conversations } = await supabase
          .from('conversations')
          .select('id')
          .in('contact_id', contactIds)
        const conversationIds = (conversations ?? []).map((c) => c.id)
        if (conversationIds.length === 0) {
          return NextResponse.json({ tickets: [], total: 0, page, pageSize })
        }
        query = query.in('conversation_id', conversationIds)
      }
    }

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1
    const { data: tickets, error, count } = await query
      .order('opened_at', { ascending: false })
      .range(from, to)

    if (error) {
      console.error('[tickets] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!tickets || tickets.length === 0) {
      return NextResponse.json({ tickets: [], total: count ?? 0, page, pageSize })
    }

    // Hydrate queue name/color + conversation's contact for display —
    // two extra indexed lookups, not a PostgREST embed (queue_id can
    // be NULL, and keeping this symmetric with the members route's
    // two-round-trip approach is simpler than mixing embed styles).
    const queueIds = [...new Set(tickets.map((t) => t.queue_id).filter((v): v is string => Boolean(v)))]
    const conversationIds = [...new Set(tickets.map((t) => t.conversation_id))]

    const [{ data: queues }, { data: conversations }] = await Promise.all([
      queueIds.length > 0
        ? supabase.from('queues').select('id, name, color').in('id', queueIds)
        : Promise.resolve({ data: [] as { id: string; name: string; color: string }[] }),
      supabase
        .from('conversations')
        .select('id, status, contact:contacts(id, name, phone)')
        .in('id', conversationIds),
    ])

    const queueById = new Map((queues ?? []).map((q2) => [q2.id, q2]))
    // Same round trip already fetching the contact join — `status` is
    // one more selected column, not an extra query. Only used to
    // derive the 5-state operational status client-side (closed vs
    // finalized, see src/lib/tickets/status.ts); tickets.status stays
    // the source of truth for everything else, unchanged.
    const conversationById = new Map(
      (conversations ?? []).map((c) => [
        c.id,
        c as unknown as { id: string; status: string; contact: { id: string; name: string | null; phone: string } | null },
      ]),
    )

    const hydrated = tickets.map((t) => ({
      ...t,
      queue: t.queue_id ? (queueById.get(t.queue_id) ?? null) : null,
      contact: conversationById.get(t.conversation_id)?.contact ?? null,
      conversation_status: conversationById.get(t.conversation_id)?.status ?? null,
    }))

    return NextResponse.json({ tickets: hydrated, total: count ?? hydrated.length, page, pageSize })
  } catch (err) {
    return toErrorResponse(err)
  }
}
