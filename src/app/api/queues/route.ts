import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/queues/admin-client'
import type { QueueFailureAction, TicketPriority } from '@/types'

// Queues — GET lists (any account member, RLS-scoped read via the
// user client); POST creates (admin/owner only). Mirrors the
// quick-replies route: RLS-scoped read, service-role write after an
// explicit role check + explicit account_id scoping.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message`. The sanitized Postgres code is logged
// server-side for diagnosis.

const FAILURE_ACTIONS: readonly QueueFailureAction[] = ['stay_in_queue', 'remove_queue', 'transfer_queue']
const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const GENERIC_ERROR = 'Failed to process the request'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (queues_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('queues')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[queues] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    return NextResponse.json({ queues: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const chatbotFailureAction: QueueFailureAction = FAILURE_ACTIONS.includes(body.chatbot_failure_action)
    ? body.chatbot_failure_action
    : 'stay_in_queue'
  const defaultPriority: TicketPriority = PRIORITIES.includes(body.default_priority)
    ? body.default_priority
    : 'normal'

  const chatbotMaxAttempts = Number.isInteger(body.chatbot_max_attempts)
    ? Math.min(10, Math.max(1, body.chatbot_max_attempts))
    : 3
  const defaultWaitMinutes = Number.isInteger(body.default_wait_minutes)
    ? Math.min(60, Math.max(1, body.default_wait_minutes))
    : 5

  let chatbotFailureQueueId: string | null = null
  if (chatbotFailureAction === 'transfer_queue') {
    const targetId = typeof body.chatbot_failure_queue_id === 'string' ? body.chatbot_failure_queue_id : ''
    if (!targetId) {
      return NextResponse.json(
        { error: 'chatbot_failure_queue_id is required when chatbot_failure_action is transfer_queue' },
        { status: 400 },
      )
    }
    // Clean 400 instead of the DB trigger's raw exception text —
    // confirm the target queue is a real queue in THIS account before
    // attempting the insert. The trigger still enforces this
    // independently either way. (Self-reference is impossible here —
    // this queue's id doesn't exist yet.)
    const { data: target } = await ctx.supabase
      .from('queues')
      .select('id')
      .eq('id', targetId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!target) {
      return NextResponse.json(
        { error: 'chatbot_failure_queue_id must reference a queue in this account' },
        { status: 400 },
      )
    }
    chatbotFailureQueueId = targetId
  }

  // account_id is always the session's, never the client's — same
  // discipline as every other account-scoped insert in this codebase.
  const { data, error } = await supabaseAdmin()
    .from('queues')
    .insert({
      account_id: ctx.accountId,
      name,
      color: typeof body.color === 'string' && body.color ? body.color : '#3b82f6',
      greeting_message: typeof body.greeting_message === 'string' ? body.greeting_message : null,
      out_of_hours_message: typeof body.out_of_hours_message === 'string' ? body.out_of_hours_message : null,
      chatbot_max_attempts: chatbotMaxAttempts,
      chatbot_failure_message: typeof body.chatbot_failure_message === 'string' ? body.chatbot_failure_message : null,
      chatbot_failure_action: chatbotFailureAction,
      chatbot_failure_queue_id: chatbotFailureQueueId,
      auto_assignment_enabled: Boolean(body.auto_assignment_enabled),
      default_wait_minutes: defaultWaitMinutes,
      default_priority: defaultPriority,
    })
    .select()
    .single()

  if (error) {
    const code = sqlCode(error)
    console.error('[queues] POST failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A queue with this name already exists' : GENERIC_ERROR }, { status })
  }
  return NextResponse.json({ queue: data }, { status: 201 })
}
