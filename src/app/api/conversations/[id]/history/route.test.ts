import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  queries: [] as {
    table: string
    columns: string | null
    eq: Record<string, unknown>
    order: { column: string; ascending: boolean | undefined }[]
  }[],
  conversation: null as Record<string, unknown> | null,
  conversationError: null as unknown,
  events: [] as Record<string, unknown>[],
  eventsError: null as unknown,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

// Guard: the route must never reach for the service-role client.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('service-role client must not be used by the history route')
  },
}))

import * as routeModule from './route'
import { GET } from './route'

const ACCOUNT = '11111111-1111-1111-1111-111111111111'
const CONVERSATION = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'

/** RLS-scoped session client fake: records every query (table, columns, filters, ordering). */
function fakeSessionClient() {
  return {
    from(table: string) {
      const q = { table, columns: null as string | null, eq: {} as Record<string, unknown>, order: [] as { column: string; ascending: boolean | undefined }[] }
      mocks.queries.push(q)
      const b: Record<string, unknown> = {}
      b.select = (columns: string) => {
        q.columns = columns
        return b
      }
      b.eq = (column: string, value: unknown) => {
        q.eq[column] = value
        return b
      }
      b.order = (column: string, opts?: { ascending?: boolean }) => {
        q.order.push({ column, ascending: opts?.ascending })
        return b
      }
      b.maybeSingle = async () => {
        if (table !== 'conversations') throw new Error(`unexpected maybeSingle on ${table}`)
        return { data: mocks.conversationError ? null : mocks.conversation, error: mocks.conversationError }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table !== 'conversation_events') throw new Error(`unexpected list query on ${table}`)
        return Promise.resolve({ data: mocks.eventsError ? null : mocks.events, error: mocks.eventsError }).then(resolve)
      }
      return b
    },
  }
}

function call(id: string) {
  return GET(new Request(`http://localhost/api/conversations/${id}/history`), {
    params: Promise.resolve({ id }),
  })
}

function event(overrides: Record<string, unknown>) {
  return {
    id: 'e0000000-0000-0000-0000-000000000000',
    event_type: 'opened',
    actor_user_id: null,
    actor_name: null,
    from_agent_id: null,
    from_agent_name: null,
    to_agent_id: null,
    to_agent_name: null,
    from_queue_id: null,
    from_queue_name: null,
    to_queue_id: null,
    to_queue_name: null,
    from_status: null,
    to_status: 'pending',
    created_at: '2026-10-06T12:00:00.000Z',
    ...overrides,
  }
}

const tables = () => mocks.queries.map((q) => q.table)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queries.length = 0
  mocks.conversation = { id: CONVERSATION }
  mocks.conversationError = null
  mocks.events = []
  mocks.eventsError = null
  mocks.requireRole.mockResolvedValue({ supabase: fakeSessionClient(), accountId: ACCOUNT, userId: USER_ID, role: 'agent' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/conversations/[id]/history — access', () => {
  it('requires at least the viewer role', async () => {
    await call(CONVERSATION)
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer')
  })

  it('unauthenticated → 401 and no query at all', async () => {
    mocks.requireRole.mockRejectedValue({ status: 401, message: 'Unauthorized' })
    const res = await call(CONVERSATION)
    expect(res.status).toBe(401)
    expect(mocks.queries).toHaveLength(0)
  })

  it('invalid UUID → generic 404 and no database query', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Conversation not found' })
    expect(mocks.queries).toHaveLength(0)
  })

  it('nonexistent conversation → generic 404, events never queried', async () => {
    mocks.conversation = null
    const res = await call(CONVERSATION)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Conversation not found' })
    expect(tables()).toEqual(['conversations'])
  })

  it('another account / hidden by RLS → the SAME generic 404 (no distinguishable response)', async () => {
    // RLS + the account filter both yield "no row" for these cases.
    mocks.conversation = null
    const hidden = await call(CONVERSATION)
    const malformed = await call('xyz')
    expect(hidden.status).toBe(404)
    expect(malformed.status).toBe(404)
    expect(await hidden.json()).toEqual(await malformed.json())
    expect(tables()).not.toContain('conversation_events')
  })

  it('the conversation is resolved with the session client: id + account_id = caller account, select id only', async () => {
    await call(CONVERSATION)
    const convQuery = mocks.queries[0]
    expect(convQuery.table).toBe('conversations')
    expect(convQuery.columns).toBe('id')
    expect(convQuery.eq).toEqual({ id: CONVERSATION, account_id: ACCOUNT })
  })
})

describe('GET /api/conversations/[id]/history — events', () => {
  it('visible conversation → 200 with conversation_id and the events', async () => {
    mocks.events = [event({ id: 'e1', event_type: 'history_started', to_status: 'in_progress' })]
    const res = await call(CONVERSATION)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversation_id).toBe(CONVERSATION)
    expect(body.events).toEqual(mocks.events)
  })

  it('events are queried only after the conversation, filtered by conversation_id AND account_id', async () => {
    await call(CONVERSATION)
    expect(tables()).toEqual(['conversations', 'conversation_events'])
    expect(mocks.queries[1].eq).toEqual({ conversation_id: CONVERSATION, account_id: ACCOUNT })
  })

  it('orders by created_at ASC, then id ASC', async () => {
    await call(CONVERSATION)
    expect(mocks.queries[1].order).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ])
  })

  it('selects exactly the 15 public columns — never account_id', async () => {
    await call(CONVERSATION)
    const columns = (mocks.queries[1].columns ?? '').split(',').map((c) => c.trim())
    expect(columns).toEqual([
      'id', 'event_type', 'actor_user_id', 'actor_name',
      'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name',
      'from_queue_id', 'from_queue_name', 'to_queue_id', 'to_queue_name',
      'from_status', 'to_status', 'created_at',
    ])
    expect(columns).not.toContain('account_id')
    expect(columns).not.toContain('*')
  })

  it('the JSON never exposes account_id', async () => {
    mocks.events = [event({ id: 'e1' })]
    const body = await (await call(CONVERSATION)).json()
    expect(JSON.stringify(body)).not.toContain('account_id')
    expect(JSON.stringify(body)).not.toContain(ACCOUNT)
  })

  it('returns the stored name snapshots exactly as stored, without querying profiles or queues', async () => {
    mocks.events = [
      event({
        id: 'e1', event_type: 'reassigned',
        actor_user_id: USER_ID, actor_name: 'Cláudia (na época)',
        from_agent_id: 'a1', from_agent_name: 'Cláudia (na época)',
        to_agent_id: 'a2', to_agent_name: 'Arthur (nome antigo)',
        from_queue_id: 'q1', from_queue_name: 'Comercial (fila renomeada depois)',
        to_queue_id: 'q1', to_queue_name: 'Comercial (fila renomeada depois)',
        from_status: 'in_progress', to_status: 'in_progress',
      }),
    ]
    const body = await (await call(CONVERSATION)).json()
    expect(body.events[0]).toEqual(mocks.events[0])
    expect(tables()).not.toContain('profiles')
    expect(tables()).not.toContain('queues')
  })

  it('returns only what the conversation-scoped query yields (no other conversation leaks in)', async () => {
    mocks.events = [event({ id: 'e1' }), event({ id: 'e2', event_type: 'assigned', from_status: 'pending', to_status: 'pending', to_agent_id: 'a1', to_agent_name: 'X' })]
    const body = await (await call(CONVERSATION)).json()
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2'])
    expect(mocks.queries.filter((q) => q.table === 'conversation_events')).toHaveLength(1)
    expect(mocks.queries[1].eq.conversation_id).toBe(CONVERSATION)
  })

  it('visible conversation without events → 200 with events: []', async () => {
    mocks.events = []
    const res = await call(CONVERSATION)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversation_id: CONVERSATION, events: [] })
  })
})

describe('GET /api/conversations/[id]/history — errors and surface', () => {
  it('conversation lookup error → generic 500, no DB message leaked, events not queried', async () => {
    mocks.conversationError = { code: '42P01', message: 'relation "conversations" does not exist' }
    const res = await call(CONVERSATION)
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('Failed to load conversation history')
    expect(text).not.toContain('relation')
    expect(tables()).toEqual(['conversations'])
  })

  it('events lookup error → generic 500, no DB message leaked', async () => {
    mocks.eventsError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await call(CONVERSATION)
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('Failed to load conversation history')
    expect(text).not.toContain('timeout')
  })

  it('logs only the SQL code, never the raw DB message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.eventsError = { code: '57014', message: 'secret detail' }
    await call(CONVERSATION)
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).toContain('57014')
    expect(logged).not.toContain('secret detail')
  })

  it('exports only GET as an HTTP method (read-only route)', () => {
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter((m) => m in routeModule)
    expect(methods).toEqual(['GET'])
  })
})
