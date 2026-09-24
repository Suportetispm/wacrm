import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adoptInboundConnectionForExistingConversation,
  type InboundConversationRow,
} from './inbound-conversation-connection'

// ETAPA 078B — adoção da conexão do inbound por uma conversation que
// já existe. Nunca sobrescreve vínculo não-NULL; NULL só é adotado com
// exatamente 1 conexão na account; nunca derruba o inbound.

function fakeDb(opts: {
  count?: number | null
  countError?: { code: string } | null
  updatedRows?: number
  updateError?: { code: string } | null
  throwOn?: 'whatsapp_config' | 'conversations'
}) {
  const calls = {
    tables: [] as string[],
    countFilters: [] as [string, unknown][],
    updatePayloads: [] as unknown[],
    updateFilters: [] as [string, string, unknown][],
  }
  const from = vi.fn((table: string) => {
    calls.tables.push(table)
    if (opts.throwOn === table) throw new Error('boom')
    if (table === 'whatsapp_config') {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(async (col: string, val: unknown) => {
        calls.countFilters.push([col, val])
        return { count: opts.countError ? null : (opts.count ?? null), error: opts.countError ?? null }
      })
      return b
    }
    const u: Record<string, unknown> = {}
    u.update = vi.fn((payload: unknown) => {
      calls.updatePayloads.push(payload)
      return u
    })
    u.eq = vi.fn((col: string, val: unknown) => {
      calls.updateFilters.push(['eq', col, val])
      return u
    })
    u.is = vi.fn((col: string, val: unknown) => {
      calls.updateFilters.push(['is', col, val])
      return u
    })
    u.select = vi.fn(async () =>
      opts.updateError
        ? { data: null, error: opts.updateError }
        : { data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ whatsapp_config_id: 'cfg-1' })), error: null },
    )
    return u
  })
  return { db: { from } as unknown as SupabaseClient, calls }
}

const ARGS = { accountId: 'acct-1', whatsappConfigId: 'cfg-1' }

describe('adoptInboundConnectionForExistingConversation', () => {
  it('already linked to the same connection → returned as-is, no DB call', async () => {
    const { db, calls } = fakeDb({})
    const conversation = { id: 'conv-1', whatsapp_config_id: 'cfg-1' }
    const result = await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })
    expect(result).toBe(conversation)
    expect(calls.tables).toEqual([])
  })

  it('linked to ANOTHER connection → never overwritten, no DB call', async () => {
    const { db, calls } = fakeDb({ count: 1 })
    const conversation = { id: 'conv-1', whatsapp_config_id: 'cfg-other' }
    const result = await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })
    expect(result.whatsapp_config_id).toBe('cfg-other')
    expect(calls.tables).toEqual([])
  })

  it('NULL + exactly 1 connection → adopted, scoped by id + account, guarded by IS NULL', async () => {
    const { db, calls } = fakeDb({ count: 1 })
    const result = await adoptInboundConnectionForExistingConversation(db, {
      conversation: { id: 'conv-1', whatsapp_config_id: null, queue_id: 'q-1' },
      ...ARGS,
    })
    expect(result).toEqual({ id: 'conv-1', whatsapp_config_id: 'cfg-1', queue_id: 'q-1' })
    expect(calls.countFilters).toEqual([['account_id', 'acct-1']])
    expect(calls.updatePayloads).toEqual([{ whatsapp_config_id: 'cfg-1' }])
    expect(calls.updateFilters).toEqual([
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acct-1'],
      ['is', 'whatsapp_config_id', null],
    ])
  })

  it('missing field (row selected before 078A) is treated like NULL', async () => {
    const { db, calls } = fakeDb({ count: 1 })
    const conversation: InboundConversationRow = { id: 'conv-1' }
    const result = await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })
    expect(result.whatsapp_config_id).toBe('cfg-1')
    expect(calls.updatePayloads).toHaveLength(1)
  })

  it.each([0, 2, 5])('NULL + %i connections → stays NULL, no update', async (count) => {
    const { db, calls } = fakeDb({ count })
    const conversation = { id: 'conv-1', whatsapp_config_id: null }
    const result = await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })
    expect(result).toBe(conversation)
    expect(calls.updatePayloads).toHaveLength(0)
  })

  it('count lookup error → stays NULL, no update', async () => {
    const { db, calls } = fakeDb({ countError: { code: '500' } })
    const conversation = { id: 'conv-1', whatsapp_config_id: null }
    expect(await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })).toBe(conversation)
    expect(calls.updatePayloads).toHaveLength(0)
  })

  it('lost the race (0 rows updated) → returns what it read, never claims the link', async () => {
    const { db } = fakeDb({ count: 1, updatedRows: 0 })
    const conversation = { id: 'conv-1', whatsapp_config_id: null }
    expect(await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })).toBe(conversation)
  })

  it('update error (e.g. FK 23503) → conversation returned unchanged, inbound not broken', async () => {
    const { db } = fakeDb({ count: 1, updateError: { code: '23503' } })
    const conversation = { id: 'conv-1', whatsapp_config_id: null }
    expect(await adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS })).toBe(conversation)
  })

  it('unexpected throw → swallowed, conversation returned unchanged', async () => {
    const { db } = fakeDb({ throwOn: 'whatsapp_config' })
    const conversation = { id: 'conv-1', whatsapp_config_id: null }
    await expect(
      adoptInboundConnectionForExistingConversation(db, { conversation, ...ARGS }),
    ).resolves.toBe(conversation)
  })
})
