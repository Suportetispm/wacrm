import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers only the accounts.is_active gate added in
// 047_platform_account_management.sql — for an inactive account, no
// contact/conversation/message is persisted and none of the three
// downstream engines (automations/flows/AI) ever run, even though the
// webhook always acks 200 to Meta (asserted separately at the route
// level; this file exercises processWebhook directly).

const state = vi.hoisted(() => ({
  configRows: [] as Record<string, unknown>[],
  accountActive: true,
  fromCalls: [] as string[],
  // Only populated by the migration-063 describe block below — an
  // existing contact/conversation to walk past the find-or-create
  // steps, and the row `meta_reopen_conversation_on_inbound` returns
  // via RETURNING * (its RPC mock echoes this back).
  contactsRows: [] as Record<string, unknown>[],
  conversationsRows: [] as Record<string, unknown>[],
  rpcResult: null as { data: unknown; error: unknown } | null,
  // ETAPA 078B: recorded conversation writes + the connection count the
  // legacy-adoption lookup sees (null = number of configRows).
  writes: [] as { table: string; op: string; payload: unknown }[],
  configCount: null as number | null,
}))

const mocks = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false, outcome: 'no_match' as const })),
  dispatchInboundToAiReply: vi.fn(async () => {}),
  dispatchWebhookEvent: vi.fn(async () => {}),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      state.fromCalls.push(table)
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: state.configRows,
                error: null,
                count: state.configCount ?? state.configRows.length,
              }),
          }),
        }
      }
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { is_active: state.accountActive }, error: null }),
            }),
          }),
        }
      }
      // contacts: only findExistingContact's `.select('*').eq(...).like(...)`
      // shape is special-cased (migration-063 describe block below needs an
      // existing contact so the pipeline reaches the reopen RPC) — the
      // insert/update paths still fall through to the generic chain.
      if (table === 'contacts' && state.contactsRows.length > 0) {
        return {
          select: () => ({
            eq: () => ({
              like: () => Promise.resolve({ data: state.contactsRows, error: null }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        }
      }
      // conversations: only findOrCreateConversation's
      // `.select('*').eq(account_id).eq(contact_id).order().limit()` shape
      // is special-cased, same reasoning as contacts above.
      if (table === 'conversations' && state.conversationsRows.length > 0) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: state.conversationsRows, error: null }),
                }),
              }),
            }),
          }),
          // ETAPA 078B legacy adoption: update().eq(id).eq(account).is(null).select()
          update: (payload: Record<string, unknown>) => {
            state.writes.push({ table, op: 'update', payload })
            const tail = { select: () => Promise.resolve({ data: [payload], error: null }) }
            return { eq: () => ({ eq: () => ({ is: () => tail }) }) }
          },
        }
      }
      // contacts/conversations/messages etc. — not modeled in this
      // file (that's covered elsewhere); a graceful "nothing found /
      // errored" response is enough to prove whether processing got
      // this far, without needing the full pipeline to succeed.
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (payload: unknown) => {
          state.writes.push({ table, op: 'insert', payload })
          return chain
        },
        update: (payload: unknown) => {
          state.writes.push({ table, op: 'update', payload })
          return chain
        },
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        is: () => chain,
        like: () => chain,
        ilike: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve({ data: null, error: { message: 'not mocked in this test' } }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(onF),
      }
      return chain
    },
    // Only meta_reopen_conversation_on_inbound is exercised by any test in
    // this file today — echoes back whatever the migration-063 describe
    // block configures as the RPC's RETURNING * row.
    rpc: () => Promise.resolve(state.rpcResult ?? { data: null, error: null }),
  }),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: mocks.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: mocks.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}))

import { processWebhook } from './route'
import { encrypt } from '@/lib/whatsapp/encryption'

function inboundBody() {
  return {
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+15550000000', phone_number_id: 'PNID-1' },
              contacts: [{ profile: { name: 'Jane' }, wa_id: '15551234567' }],
              messages: [
                {
                  id: 'wamid.1',
                  from: '15551234567',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  state.configRows = [
    {
      id: 'cfg-meta-1',
      account_id: 'acct-1',
      user_id: 'user-1',
      phone_number_id: 'PNID-1',
      access_token: encrypt('fake-meta-access-token'),
    },
  ]
  state.accountActive = true
  state.fromCalls = []
  state.contactsRows = []
  state.conversationsRows = []
  state.rpcResult = null
  state.writes = []
  state.configCount = null
  mocks.runAutomationsForTrigger.mockClear()
  mocks.dispatchInboundToFlows.mockClear()
  mocks.dispatchInboundToAiReply.mockClear()
  mocks.dispatchWebhookEvent.mockClear()
})

describe('processWebhook — inactive account (accounts.is_active = false)', () => {
  it('drops the inbound message — no contact/conversation/message persisted, no engines run', async () => {
    state.accountActive = false

    await expect(processWebhook(inboundBody())).resolves.not.toThrow()

    expect(state.fromCalls).toContain('accounts')
    expect(mocks.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(mocks.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(mocks.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('an active account proceeds past the gate (no regression) — reaches the contact lookup', async () => {
    state.accountActive = true

    await expect(processWebhook(inboundBody())).resolves.not.toThrow()

    expect(state.fromCalls).toContain('accounts')
    expect(state.fromCalls).toContain('contacts')
  })
})

describe('processMessage — Flow dispatch uses the RPC\'s post-reopen state (migration 063)', () => {
  // These configure an existing contact/conversation so the pipeline
  // reaches meta_reopen_conversation_on_inbound and dispatchInboundToFlows
  // for real, instead of short-circuiting earlier like the tests above.
  beforeEach(() => {
    state.contactsRows = [{ id: 'contact-1', account_id: 'acct-1', phone: '15551234567', name: 'Jane' }]
    state.conversationsRows = [
      {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        // Stale values as they were BEFORE the reopen RPC ran — this is
        // the `conversation` object route.ts holds from its earlier
        // find-or-create lookup. If the fix regressed, these are the
        // values that would leak into dispatchInboundToFlows.
        queue_id: 'queue-old',
        assigned_agent_id: 'agent-old',
        status: 'closed',
      },
    ]
  })

  it('passes queueId/assignedAgentId null to the Flow runner when the RPC cleared them (conversation was closed)', async () => {
    state.rpcResult = {
      data: {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        queue_id: null,
        assigned_agent_id: null,
        status: 'pending',
      },
      error: null,
    }

    await expect(processWebhook(inboundBody())).resolves.not.toThrow()

    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: null, assignedAgentId: null }),
    )
  })

  it('passes through the RPC\'s unchanged routing when it did not clear anything (e.g. conversation has a ticket)', async () => {
    state.rpcResult = {
      data: {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        queue_id: 'queue-old',
        assigned_agent_id: 'agent-old',
        status: 'closed',
      },
      error: null,
    }

    await expect(processWebhook(inboundBody())).resolves.not.toThrow()

    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 'queue-old', assignedAgentId: 'agent-old' }),
    )
  })

  it('falls back to the pre-RPC conversation object if the RPC itself errors', async () => {
    state.rpcResult = { data: null, error: { message: 'boom' } }

    await expect(processWebhook(inboundBody())).resolves.not.toThrow()

    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 'queue-old', assignedAgentId: 'agent-old' }),
    )
  })
})

describe('processMessage — ETAPA 078B: conversation records the inbound connection', () => {
  const CONTACT = { id: 'contact-1', account_id: 'acct-1', phone: '15551234567', name: 'Jane' }
  const convWrites = (op: string) =>
    state.writes.filter((w) => w.table === 'conversations' && w.op === op)
  const withConversation = (whatsappConfigId: string | null) => {
    state.contactsRows = [CONTACT]
    state.conversationsRows = [
      { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: whatsappConfigId },
    ]
    state.rpcResult = { data: { id: 'conv-1', queue_id: null, assigned_agent_id: null }, error: null }
  }

  it('a NEW conversation is inserted with whatsapp_config_id = the config resolved from phone_number_id', async () => {
    state.contactsRows = [CONTACT] // existing contact, no conversation yet

    await processWebhook(inboundBody())

    const inserts = convWrites('insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].payload).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      whatsapp_config_id: 'cfg-meta-1',
    })
  })

  it('an existing conversation linked to this connection is reused untouched; Flow gets the same conversationId', async () => {
    withConversation('cfg-meta-1')

    await processWebhook(inboundBody())

    expect(convWrites('insert')).toHaveLength(0)
    expect(convWrites('update')).toHaveLength(0)
    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
  })

  it('an existing link to ANOTHER connection is never overwritten', async () => {
    withConversation('cfg-other')

    await processWebhook(inboundBody())

    expect(convWrites('update')).toHaveLength(0)
    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
  })

  it('a legacy NULL conversation is adopted when the account has exactly 1 connection', async () => {
    withConversation(null)
    state.configCount = 1

    await processWebhook(inboundBody())

    const updates = convWrites('update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ whatsapp_config_id: 'cfg-meta-1' })
    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
  })

  it('a legacy NULL conversation stays NULL when the account has >1 connections', async () => {
    withConversation(null)
    state.configCount = 2

    await processWebhook(inboundBody())

    expect(convWrites('update')).toHaveLength(0)
    expect(mocks.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
  })
})
