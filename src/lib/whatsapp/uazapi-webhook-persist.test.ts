import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistInboundTextMessage } from './uazapi-webhook-persist'
import type { ParsedInboundTextMessage } from './uazapi-webhook-parser'

// No real database anywhere in this file — every Supabase call is a
// hand-rolled, per-test-configurable mock.

const PARSED: ParsedInboundTextMessage = {
  externalMessageId: 'fixture-ext-id',
  phone: '551199999999',
  name: 'Fixture Contact',
  text: 'fixture text',
  occurredAt: '2026-01-01T00:00:00.000Z',
}

interface DbState {
  existingContact: Record<string, unknown> | null
  contactInsertError: { code: string } | null
  existingConversation: Record<string, unknown> | null
  conversationInsertError: { code: string } | null
  rpcData: string | null
  rpcError: { code: string } | null
  /** Prior customer-message count on the conversation — drives isFirstInboundMessage. */
  priorCustomerMsgCount: number
  /**
   * What the post-RPC `.select('queue_id, assigned_agent_id').eq('id', ...).maybeSingle()`
   * re-read returns — migration 063's cleanup happens inside the RPC
   * itself (never exercised here, no real Postgres in this file), so
   * this is how a test simulates "the RPC already cleared routing
   * because the conversation was closed/finalized". `null` simulates
   * the re-read finding no row (should not happen, but never assumed
   * unrouted — see `rereadError` below for the other fail-safe case).
   */
  freshConversation: { queue_id: string | null; assigned_agent_id: string | null } | null
  /** When set, the post-RPC re-read itself errors — routingState must
   *  come back `null`, never a fabricated `{queueId:null,...}`. */
  rereadError: { code: string } | null
}

function defaultState(overrides: Partial<DbState> = {}): DbState {
  return {
    existingContact: null,
    contactInsertError: null,
    existingConversation: null,
    conversationInsertError: null,
    rpcData: 'persisted',
    rpcError: null,
    priorCustomerMsgCount: 0,
    freshConversation: { queue_id: null, assigned_agent_id: null },
    rereadError: null,
    ...overrides,
  }
}

function makeDb(state: DbState) {
  const contactAfterInsert = { id: 'contact-new', account_id: 'acct-1', phone: PARSED.phone }
  const conversationAfterInsert = { id: 'conv-new', account_id: 'acct-1', contact_id: 'contact-new' }

  function contactsBuilder() {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.like = vi.fn(() => b)
    b.insert = vi.fn(() => b)
    b.single = vi.fn(() =>
      Promise.resolve(
        state.contactInsertError
          ? { data: null, error: state.contactInsertError }
          : { data: contactAfterInsert, error: null },
      ),
    )
    // findExistingContact awaits the select/eq/like chain directly —
    // no terminal method call, so the builder itself must be thenable.
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: state.existingContact ? [state.existingContact] : [], error: null })
    return b
  }

  function conversationsBuilder() {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.order = vi.fn(() => b)
    b.limit = vi.fn(() => b)
    b.insert = vi.fn(() => b)
    b.single = vi.fn(() =>
      Promise.resolve(
        state.conversationInsertError
          ? { data: null, error: state.conversationInsertError }
          : { data: conversationAfterInsert, error: null },
      ),
    )
    // Post-RPC re-read (migration 063) — `.select('queue_id, assigned_agent_id').eq('id', ...).maybeSingle()`.
    // Only this call path uses `.maybeSingle()`; the find-or-create lookup above is thenable instead.
    b.maybeSingle = vi.fn(() =>
      Promise.resolve({ data: state.rereadError ? null : state.freshConversation, error: state.rereadError }),
    )
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data: state.existingConversation ? [state.existingConversation] : [],
        error: null,
      })
    return b
  }

  function messagesBuilder() {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    // isFirstInboundMessage's count query awaits the select/eq/eq chain
    // directly (head:true, no terminal call) — thenable, like contacts/conversations.
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ count: state.priorCustomerMsgCount, error: null })
    return b
  }

  const rpc = vi.fn(async () => ({ data: state.rpcData, error: state.rpcError }))

  const db = {
    from: vi.fn((table: string) => {
      if (table === 'contacts') return contactsBuilder()
      if (table === 'conversations') return conversationsBuilder()
      if (table === 'messages') return messagesBuilder()
      throw new Error(`unexpected table in test: ${table}`)
    }),
    rpc,
  }

  return { db: db as unknown as SupabaseClient, rpc }
}

const ARGS_BASE = { accountId: 'acct-1', configOwnerUserId: 'user-1', parsed: PARSED }

describe('persistInboundTextMessage', () => {
  it('returns outcome "persisted" when the RPC reports a new row', async () => {
    const { db, rpc } = makeDb(defaultState({ rpcData: 'persisted' }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({
      outcome: 'persisted',
      contactId: 'contact-new',
      conversationId: 'conv-new',
      routingState: { queueId: null, assignedAgentId: null },
      isFirstInboundMessage: true,
    })
    expect(rpc).toHaveBeenCalledWith('uazapi_persist_inbound_text_message', {
      p_conversation_id: 'conv-new',
      p_message_id: PARSED.externalMessageId,
      p_content_text: PARSED.text,
      p_occurred_at: PARSED.occurredAt,
    })
  })

  it('returns outcome "duplicate" when the RPC reports a conflict', async () => {
    const { db } = makeDb(defaultState({ rpcData: 'duplicate' }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({
      outcome: 'duplicate',
      contactId: 'contact-new',
      conversationId: 'conv-new',
      routingState: { queueId: null, assignedAgentId: null },
      isFirstInboundMessage: true,
    })
  })

  it('returns outcome "error" with code database_failed on a real RPC error', async () => {
    const { db } = makeDb(defaultState({ rpcData: null, rpcError: { code: '42P10' } }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
  })

  it('returns outcome "error" with code database_failed on an unexpected RPC return value', async () => {
    const { db } = makeDb(defaultState({ rpcData: 'something-unexpected', rpcError: null }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
  })

  it('never treats a duplicate or a real error the same way as each other', async () => {
    const { db: dbDup } = makeDb(defaultState({ rpcData: 'duplicate' }))
    const { db: dbErr } = makeDb(defaultState({ rpcData: null, rpcError: { code: 'XX000' } }))
    const dup = await persistInboundTextMessage({ db: dbDup, ...ARGS_BASE })
    const err = await persistInboundTextMessage({ db: dbErr, ...ARGS_BASE })
    expect(dup.outcome).toBe('duplicate')
    expect(err.outcome).toBe('error')
    expect(dup).not.toEqual(err)
  })

  it('returns outcome "error" with code contact_failed when contact creation fails for a non-conflict reason', async () => {
    const { db, rpc } = makeDb(defaultState({ contactInsertError: { code: '23503' } }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({ outcome: 'error', code: 'contact_failed' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns outcome "error" with code conversation_failed when conversation creation fails for a non-conflict reason', async () => {
    const { db, rpc } = makeDb(defaultState({ conversationInsertError: { code: '23503' } }))
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({ outcome: 'error', code: 'conversation_failed' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reuses an existing contact and conversation instead of inserting', async () => {
    const { db, rpc } = makeDb(
      defaultState({
        existingContact: { id: 'contact-existing', account_id: 'acct-1', phone: PARSED.phone },
        existingConversation: { id: 'conv-existing', account_id: 'acct-1', contact_id: 'contact-existing' },
      }),
    )
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({
      outcome: 'persisted',
      contactId: 'contact-existing',
      conversationId: 'conv-existing',
      routingState: { queueId: null, assignedAgentId: null },
      isFirstInboundMessage: true,
    })
    expect(rpc).toHaveBeenCalledWith(
      'uazapi_persist_inbound_text_message',
      expect.objectContaining({ p_conversation_id: 'conv-existing' }),
    )
  })

  it('recovers from a contact unique-violation race by re-resolving the winner', async () => {
    const { db } = makeDb(
      defaultState({
        contactInsertError: { code: '23505' },
        // After the race, a re-query finds the winner — simulate by
        // flipping existingContact once the insert has been attempted.
      }),
    )
    // The mock's findExistingContact always returns null on the first
    // pass (no existingContact configured) and the insert path hits a
    // 23505 — persistInboundTextMessage should re-call findExistingContact,
    // which still returns null here, so this exercises the "still not
    // found after a real race" contact_failed path deliberately, to
    // prove isUniqueViolation is actually being checked (23503 above
    // returns contact_failed immediately with no retry; 23505 must
    // retry via findExistingContact before giving up).
    const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
    expect(result).toEqual({ outcome: 'error', code: 'contact_failed' })
    // Two select-chain calls on 'contacts': the initial lookup + the
    // post-conflict re-resolve.
    const contactsCalls = (db.from as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'contacts',
    )
    expect(contactsCalls.length).toBeGreaterThanOrEqual(3) // lookup, insert, re-lookup
  })

  // Migration 063: a message arriving on a closed/finalized conversation
  // may have just had its queue_id/assigned_agent_id cleared by the RPC
  // itself (new service entry). These prove the returned outcome reflects
  // that POST-reopen state, not the conversation object read before the
  // RPC ran — the exact bug this migration fixes.
  describe('post-reopen routing state (migration 063)', () => {
    it('returns queueId/assignedAgentId null when the RPC cleared them, even though the pre-RPC conversation object still had them set', async () => {
      const { db } = makeDb(
        defaultState({
          existingContact: { id: 'contact-existing', account_id: 'acct-1', phone: PARSED.phone },
          existingConversation: {
            id: 'conv-existing',
            account_id: 'acct-1',
            contact_id: 'contact-existing',
            // Stale values as read BEFORE the RPC ran — closed conversation
            // routed by an old Flow. The RPC clears these server-side; the
            // fresh re-read below is what the outcome must reflect.
            queue_id: 'queue-old',
            assigned_agent_id: 'agent-old',
            status: 'closed',
          },
          freshConversation: { queue_id: null, assigned_agent_id: null },
        }),
      )
      const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
      expect(result).toMatchObject({
        outcome: 'persisted',
        conversationId: 'conv-existing',
        routingState: { queueId: null, assignedAgentId: null },
      })
    })

    it('still reports a routed conversation (pending/in_progress, ticket present, etc.) when the RPC did NOT clear routing', async () => {
      const { db } = makeDb(
        defaultState({
          existingContact: { id: 'contact-existing', account_id: 'acct-1', phone: PARSED.phone },
          existingConversation: {
            id: 'conv-existing',
            account_id: 'acct-1',
            contact_id: 'contact-existing',
            queue_id: 'queue-current',
            assigned_agent_id: 'agent-current',
            status: 'in_progress',
          },
          // Conversation was never closed/finalized (or has a ticket) —
          // the RPC's CASE never fires, routing stays exactly as-is.
          freshConversation: { queue_id: 'queue-current', assigned_agent_id: 'agent-current' },
        }),
      )
      const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
      expect(result).toMatchObject({
        outcome: 'persisted',
        routingState: { queueId: 'queue-current', assignedAgentId: 'agent-current' },
      })
    })

    it('FAIL-SAFE: returns routingState:null (never a fabricated {queueId:null,...}) when the post-RPC re-read itself errors', async () => {
      const { db } = makeDb(
        defaultState({
          existingContact: { id: 'contact-existing', account_id: 'acct-1', phone: PARSED.phone },
          existingConversation: {
            id: 'conv-existing',
            account_id: 'acct-1',
            contact_id: 'contact-existing',
            queue_id: 'queue-current',
            assigned_agent_id: 'agent-current',
            status: 'in_progress',
          },
          rereadError: { code: '57014' },
        }),
      )
      const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
      expect(result).toMatchObject({ outcome: 'persisted', routingState: null })
    })

    it('FAIL-SAFE: returns routingState:null when the re-read finds no row (should not happen, but never assumed unrouted)', async () => {
      const { db } = makeDb(
        defaultState({
          existingContact: { id: 'contact-existing', account_id: 'acct-1', phone: PARSED.phone },
          existingConversation: {
            id: 'conv-existing',
            account_id: 'acct-1',
            contact_id: 'contact-existing',
            queue_id: 'queue-current',
            assigned_agent_id: 'agent-current',
          },
          freshConversation: null,
        }),
      )
      const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
      expect(result).toMatchObject({ outcome: 'persisted', routingState: null })
    })

    it('normal text behavior is otherwise unchanged: an unrouted conversation with confirmed routingState still lets the caller dispatch a fresh triage', async () => {
      const { db } = makeDb(
        defaultState({
          freshConversation: { queue_id: null, assigned_agent_id: null },
        }),
      )
      const result = await persistInboundTextMessage({ db, ...ARGS_BASE })
      expect(result).toMatchObject({
        outcome: 'persisted',
        routingState: { queueId: null, assignedAgentId: null },
        isFirstInboundMessage: true,
      })
    })
  })
})
