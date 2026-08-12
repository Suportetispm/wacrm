import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/queues/admin-client'
import type { QueueFailureAction, TicketPriority } from '@/types'

// GET one queue (any member, RLS-scoped); PATCH edits fields OR
// applies a lifecycle action (pause/activate/archive) — never a
// physical delete, there is no DELETE handler on this route at all.
//
// Every DB error returned to the client is a generic, fixed message —
// never `error.message` (which can carry internal detail, e.g. the
// tenancy trigger's exception text). The sanitized Postgres code
// (never the message) is logged server-side for diagnosis.

const FAILURE_ACTIONS: readonly QueueFailureAction[] = ['stay_in_queue', 'remove_queue', 'transfer_queue']
const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const LIFECYCLE_ACTIONS = ['pause', 'activate', 'archive'] as const
const GENERIC_ERROR = 'Failed to process the request'

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
    const { data, error } = await supabase.from('queues').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error('[queues/[id]] GET failed:', sqlCode(error))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Queue not found' }, { status: 404 })
    return NextResponse.json({ queue: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}

  // Lifecycle action: pause (is_active=false, archived_at untouched);
  // activate (is_active=true — but ONLY from a paused state, never
  // directly out of archived: archiving is meant to be a one-way,
  // terminal state, not a second "pause" — reactivating an archived
  // queue isn't supported by this action); archive (is_active=false,
  // archived_at=now()). Never a physical delete.
  if (typeof body.action === 'string') {
    if (!(LIFECYCLE_ACTIONS as readonly string[]).includes(body.action)) {
      return NextResponse.json({ error: `action must be one of: ${LIFECYCLE_ACTIONS.join(', ')}` }, { status: 400 })
    }

    if (body.action === 'activate') {
      const { data: current, error: currentError } = await ctx.supabase
        .from('queues')
        .select('archived_at')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (currentError) {
        console.error('[queues/[id]] activate pre-check failed:', sqlCode(currentError))
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
      }
      if (!current) return NextResponse.json({ error: 'Queue not found' }, { status: 404 })
      if (current.archived_at) {
        return NextResponse.json(
          { error: 'An archived queue cannot be reactivated directly' },
          { status: 409 },
        )
      }
      update.is_active = true
    }
    if (body.action === 'pause') update.is_active = false
    if (body.action === 'archive') {
      update.is_active = false
      update.archived_at = new Date().toISOString()
    }
  } else {
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      update.name = name
    }
    if (typeof body.color === 'string' && body.color) update.color = body.color
    if ('greeting_message' in body) update.greeting_message = body.greeting_message ?? null
    if ('out_of_hours_message' in body) update.out_of_hours_message = body.out_of_hours_message ?? null
    if (Number.isInteger(body.chatbot_max_attempts)) {
      update.chatbot_max_attempts = Math.min(10, Math.max(1, body.chatbot_max_attempts))
    }
    if ('chatbot_failure_message' in body) update.chatbot_failure_message = body.chatbot_failure_message ?? null

    // chatbot_failure_action and chatbot_failure_queue_id are only
    // ever accepted TOGETHER — never chatbot_failure_queue_id alone.
    // That removes an edge case where the DB's own CHECK constraint
    // ends up being the only thing enforcing the transfer_queue
    // biconditional (surfacing as a raw, unsanitized error) instead
    // of this route validating it cleanly up front.
    if (typeof body.chatbot_failure_action === 'string') {
      if (!FAILURE_ACTIONS.includes(body.chatbot_failure_action as QueueFailureAction)) {
        return NextResponse.json({ error: `chatbot_failure_action must be one of: ${FAILURE_ACTIONS.join(', ')}` }, { status: 400 })
      }
      update.chatbot_failure_action = body.chatbot_failure_action

      if (body.chatbot_failure_action === 'transfer_queue') {
        const targetId = typeof body.chatbot_failure_queue_id === 'string' ? body.chatbot_failure_queue_id : ''
        if (!targetId) {
          return NextResponse.json(
            { error: 'chatbot_failure_queue_id is required when chatbot_failure_action is transfer_queue' },
            { status: 400 },
          )
        }
        if (targetId === id) {
          return NextResponse.json(
            { error: 'chatbot_failure_queue_id cannot be the queue itself' },
            { status: 400 },
          )
        }
        // Clean 400 instead of the DB trigger's raw exception text —
        // confirm the target queue is a real queue in THIS account
        // before attempting the update. The trigger still enforces
        // this independently either way.
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
        update.chatbot_failure_queue_id = targetId
      } else {
        update.chatbot_failure_queue_id = null
      }
    }

    if ('auto_assignment_enabled' in body) update.auto_assignment_enabled = Boolean(body.auto_assignment_enabled)
    if (Number.isInteger(body.default_wait_minutes)) {
      update.default_wait_minutes = Math.min(60, Math.max(1, body.default_wait_minutes))
    }
    if (typeof body.default_priority === 'string') {
      if (!PRIORITIES.includes(body.default_priority as TicketPriority)) {
        return NextResponse.json({ error: `default_priority must be one of: ${PRIORITIES.join(', ')}` }, { status: 400 })
      }
      update.default_priority = body.default_priority
    }

    // primary_agent_id (051): null clears it (always allowed — mirrors
    // how the DB trigger treats NULL as a no-op). A non-null value gets
    // the same "clean 400 instead of the trigger's raw exception text"
    // treatment as chatbot_failure_queue_id above — confirm the target
    // is an ACTIVE member of THIS queue before attempting the update.
    // The DB trigger (queues_validate_primary_agent, 051) is still the
    // authoritative check — it additionally covers profile/account
    // active state and role, which this route does not duplicate.
    if ('primary_agent_id' in body) {
      if (body.primary_agent_id === null) {
        update.primary_agent_id = null
      } else if (typeof body.primary_agent_id === 'string' && body.primary_agent_id) {
        const { data: member } = await ctx.supabase
          .from('queue_members')
          .select('id')
          .eq('queue_id', id)
          .eq('user_id', body.primary_agent_id)
          .eq('account_id', ctx.accountId)
          .eq('is_active', true)
          .maybeSingle()
        if (!member) {
          return NextResponse.json(
            { error: 'primary_agent_id must be an active member of this queue' },
            { status: 400 },
          )
        }
        update.primary_agent_id = body.primary_agent_id
      } else {
        return NextResponse.json({ error: 'primary_agent_id must be a string or null' }, { status: 400 })
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('queues')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) {
    const code = sqlCode(error)
    console.error('[queues/[id]] PATCH failed:', code)
    const status = code === '23505' ? 409 : 500
    return NextResponse.json({ error: status === 409 ? 'A queue with this name already exists' : GENERIC_ERROR }, { status })
  }
  if (!data) return NextResponse.json({ error: 'Queue not found' }, { status: 404 })
  return NextResponse.json({ queue: data })
}
