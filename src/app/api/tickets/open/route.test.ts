import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

vi.mock('@/lib/queues/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc }),
}))

import { POST } from './route'

function request(body: unknown) {
  return new Request('http://localhost/api/tickets/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function ctx(opts: { conversationInAccount: boolean; queueInAccount?: boolean }) {
  return {
    accountId: 'acct-1',
    userId: 'user-1',
    supabase: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (table === 'conversations') {
                  return { data: opts.conversationInAccount ? { id: 'conv-1' } : null, error: null }
                }
                return { data: opts.queueInAccount ? { id: 'queue-1' } : null, error: null }
              },
            }),
          }),
        }),
      }),
    },
  }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.rpc.mockReset()
})

describe('POST /api/tickets/open', () => {
  it('rejects a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(request({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing conversation_id before calling the RPC', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true }))
    const res = await POST(request({}))
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a conversation that does not belong to this account, before calling the RPC', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: false }))
    const res = await POST(request({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a queue_id that does not belong to this account, before calling the RPC', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true, queueInAccount: false }))
    const res = await POST(request({ conversation_id: 'conv-1', queue_id: 'queue-1' }))
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns the ticket on a well-formed RPC response', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true }))
    mocks.rpc.mockResolvedValue({
      data: { id: 'ticket-1', ticket_number: 1, status: 'open', conversation_id: 'conv-1' },
      error: null,
    })
    const res = await POST(request({ conversation_id: 'conv-1' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.ticket.id).toBe('ticket-1')
    expect(mocks.rpc).toHaveBeenCalledWith(
      'open_ticket_for_conversation',
      expect.objectContaining({ p_account_id: 'acct-1', p_conversation_id: 'conv-1', p_actor_user_id: 'user-1' }),
    )
  })

  it('treats a real RPC error as a failure, never as success', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true }))
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } })
    const res = await POST(request({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(502)
  })

  it('treats an unexpected RPC return shape as a failure, never as success', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true }))
    mocks.rpc.mockResolvedValue({ data: 'not-an-object', error: null })
    const res = await POST(request({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(502)
  })

  it('treats a partial/malformed ticket object as a failure', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ conversationInAccount: true }))
    mocks.rpc.mockResolvedValue({ data: { id: 'ticket-1' }, error: null })
    const res = await POST(request({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(502)
  })
})
