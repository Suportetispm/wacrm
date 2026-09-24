import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkNewConnectionAllowed } from './connection-gate'

// ETAPA 078-0 — gate de multiconexão. Usa o isAccountFeatureEnabled
// real (não mockado), para que "flag ausente" e "erro ao ler a flag"
// exercitem o default fail-closed de verdade.

type FlagRow = { enabled: boolean } | null

function adminStub(opts: {
  count?: number | null
  countError?: { message: string } | null
  flag?: FlagRow
  flagError?: { message: string } | null
}) {
  const calls: string[] = []
  const from = vi.fn((table: string) => {
    calls.push(table)
    if (table === 'whatsapp_config') {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(async () => ({
        count: opts.countError ? null : (opts.count ?? 0),
        error: opts.countError ?? null,
      }))
      return b
    }
    if (table === 'account_feature_flags') {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => ({
        data: opts.flagError ? null : (opts.flag ?? null),
        error: opts.flagError ?? null,
      }))
      return b
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { admin: { from } as unknown as SupabaseClient, calls }
}

describe('checkNewConnectionAllowed', () => {
  it('allows the first connection with the flag off (zero connections)', async () => {
    const { admin } = adminStub({ count: 0, flag: { enabled: false } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate).toEqual({ allowed: true, connectionCount: 0, multiConnectionEnabled: false })
  })

  it('blocks a second connection with the flag off', async () => {
    const { admin } = adminStub({ count: 1, flag: { enabled: false } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate).toEqual({ allowed: false, reason: 'multi_connection_disabled', connectionCount: 1 })
  })

  it('allows a second connection with the flag on', async () => {
    const { admin } = adminStub({ count: 1, flag: { enabled: true } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate).toEqual({ allowed: true, connectionCount: 1, multiConnectionEnabled: true })
  })

  it('treats a missing flag row as disabled (safe default)', async () => {
    const { admin } = adminStub({ count: 1, flag: null })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate.allowed).toBe(false)
  })

  it('treats a flag read error as disabled (e.g. table not present)', async () => {
    const { admin } = adminStub({ count: 2, flagError: { message: 'relation does not exist' } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate).toEqual({ allowed: false, reason: 'multi_connection_disabled', connectionCount: 2 })
  })

  it('still allows the first connection when the flag read fails', async () => {
    const { admin } = adminStub({ count: 0, flagError: { message: 'boom' } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate.allowed).toBe(true)
  })

  it('fails closed when the connection count cannot be read', async () => {
    const { admin } = adminStub({ countError: { message: 'boom' }, flag: { enabled: true } })
    const gate = await checkNewConnectionAllowed(admin, 'acct-1')
    expect(gate).toEqual({ allowed: false, reason: 'lookup_failed' })
  })
})
