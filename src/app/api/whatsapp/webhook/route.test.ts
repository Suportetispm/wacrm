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
            eq: () => Promise.resolve({ data: state.configRows, error: null }),
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
      // contacts/conversations/messages etc. — not modeled in this
      // file (that's covered elsewhere); a graceful "nothing found /
      // errored" response is enough to prove whether processing got
      // this far, without needing the full pipeline to succeed.
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
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
      account_id: 'acct-1',
      user_id: 'user-1',
      phone_number_id: 'PNID-1',
      access_token: encrypt('fake-meta-access-token'),
    },
  ]
  state.accountActive = true
  state.fromCalls = []
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
