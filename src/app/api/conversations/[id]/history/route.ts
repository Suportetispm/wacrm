import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { ConversationEvent } from '@/types'

// GET /api/conversations/[id]/history — read-only attendance history of
// one conversation (migration 086: public.conversation_events).
//
// Authorization is the caller's own RLS-scoped session client — never
// the service-role client:
//   1. the conversation is resolved first, through conversations RLS
//      (the hybrid Inbox visibility of migration 083) AND an explicit
//      account_id = caller's account filter (second layer);
//   2. only then are its events read — conversation_events RLS (086)
//      also derives from conversation visibility, and the query repeats
//      both filters (conversation_id + account_id).
// Rule A: whoever can see the conversation sees its whole history; the
// queue an old event happened in is never used to filter.
//
// Malformed id, nonexistent conversation, another account's conversation
// and a conversation hidden by RLS all answer the SAME generic 404 —
// distinguishing them would confirm that an id exists elsewhere (same
// reasoning as GET /api/tickets/[id] and GET /api/contacts/[id]/avatar).
//
// Names come only from the snapshots stored on each event (*_name),
// never re-resolved from profiles/queues. account_id is never returned.
// Raw events, chronological; no episode grouping and no pagination
// (same precedent as ticket_events and the message thread).
// DB errors answer a fixed message; only the SQL code is logged.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EVENT_COLUMNS =
  'id, event_type, actor_user_id, actor_name, ' +
  'from_agent_id, from_agent_name, to_agent_id, to_agent_name, ' +
  'from_queue_id, from_queue_name, to_queue_id, to_queue_name, ' +
  'from_status, to_status, created_at'

const GENERIC_ERROR = 'Failed to load conversation history'

function notFound() {
  return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
}

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
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!UUID_RE.test(id)) return notFound()

  const { data: conversation, error: conversationError } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (conversationError) {
    console.error('[conversations/history] conversation lookup failed:', sqlCode(conversationError))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!conversation) return notFound()

  const { data: events, error: eventsError } = await ctx.supabase
    .from('conversation_events')
    .select(EVENT_COLUMNS)
    .eq('conversation_id', id)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (eventsError) {
    console.error('[conversations/history] events lookup failed:', sqlCode(eventsError))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }

  return NextResponse.json({
    conversation_id: id,
    events: (events ?? []) as unknown as ConversationEvent[],
  })
}
