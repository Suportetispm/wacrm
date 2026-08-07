import { describe, expect, it } from 'vitest'

import { getActiveAccountIds, isAccountActive } from './active'

function makeAdmin(opts: {
  singleResult?: { data: unknown; error: unknown }
  batchResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: unknown) => {
          // isAccountActive path: .select('is_active').eq('id', x).maybeSingle()
          if (col === 'id') {
            return {
              maybeSingle: async () => opts.singleResult ?? { data: null, error: null },
              // getActiveAccountIds path chains .in().eq() — handled below.
            }
          }
          // .eq('is_active', true) — terminal for the batch path.
          void val
          return Promise.resolve(opts.batchResult ?? { data: [], error: null })
        },
        in: () => ({
          eq: async () => opts.batchResult ?? { data: [], error: null },
        }),
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('isAccountActive', () => {
  it('returns true for an active account', async () => {
    const admin = makeAdmin({ singleResult: { data: { is_active: true }, error: null } })
    expect(await isAccountActive(admin, 'acct-1')).toBe(true)
  })

  it('returns false for a disabled account', async () => {
    const admin = makeAdmin({ singleResult: { data: { is_active: false }, error: null } })
    expect(await isAccountActive(admin, 'acct-1')).toBe(false)
  })

  it('fails closed (false) when the account is not found', async () => {
    const admin = makeAdmin({ singleResult: { data: null, error: null } })
    expect(await isAccountActive(admin, 'ghost-acct')).toBe(false)
  })

  it('fails closed (false) on a read error, without throwing', async () => {
    const admin = makeAdmin({ singleResult: { data: null, error: { message: 'db down' } } })
    await expect(isAccountActive(admin, 'acct-1')).resolves.toBe(false)
  })
})

describe('getActiveAccountIds', () => {
  it('returns only the ids that came back active', async () => {
    const admin = makeAdmin({ batchResult: { data: [{ id: 'acct-1' }], error: null } })
    const result = await getActiveAccountIds(admin, ['acct-1', 'acct-2'])
    expect(result.has('acct-1')).toBe(true)
    expect(result.has('acct-2')).toBe(false)
  })

  it('returns an empty set without querying for an empty input', async () => {
    const admin = makeAdmin({})
    const result = await getActiveAccountIds(admin, [])
    expect(result.size).toBe(0)
  })

  it('fails closed (empty set — nothing treated as active) on a read error', async () => {
    const admin = makeAdmin({ batchResult: { data: null, error: { message: 'db down' } } })
    const result = await getActiveAccountIds(admin, ['acct-1'])
    expect(result.size).toBe(0)
  })
})
