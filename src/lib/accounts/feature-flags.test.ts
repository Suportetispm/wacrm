import { describe, expect, it } from 'vitest'

import {
  getAccountFeatureFlags,
  isAccountFeatureEnabled,
  isAccountFeatureKey,
} from './feature-flags'

function makeAdmin(opts: {
  singleResult?: { data: unknown; error: unknown }
  listResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      select: () => ({
        // isAccountFeatureEnabled path: .select('enabled')
        //   .eq('account_id', x).eq('feature_key', y).maybeSingle()
        // getAccountFeatureFlags path: .select('feature_key, enabled')
        //   .eq('account_id', x) — terminal, thenable, no second .eq().
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => opts.singleResult ?? { data: null, error: null },
          }),
          then: (resolve: (value: { data: unknown; error: unknown }) => void) =>
            resolve(opts.listResult ?? { data: [], error: null }),
        }),
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('isAccountFeatureKey', () => {
  it('accepts only the known catalog keys', () => {
    expect(isAccountFeatureKey('multi_connection_enabled')).toBe(true)
    expect(isAccountFeatureKey('business_units_enabled')).toBe(true)
    expect(isAccountFeatureKey('anything_else')).toBe(false)
    expect(isAccountFeatureKey(undefined)).toBe(false)
  })
})

describe('isAccountFeatureEnabled', () => {
  it('returns true when the row is enabled', async () => {
    const admin = makeAdmin({ singleResult: { data: { enabled: true }, error: null } })
    expect(await isAccountFeatureEnabled(admin, 'acct-1', 'multi_connection_enabled')).toBe(true)
  })

  it('returns false when the row is explicitly disabled', async () => {
    const admin = makeAdmin({ singleResult: { data: { enabled: false }, error: null } })
    expect(await isAccountFeatureEnabled(admin, 'acct-1', 'multi_connection_enabled')).toBe(false)
  })

  it('fails closed (false) when no row exists — absence means disabled', async () => {
    const admin = makeAdmin({ singleResult: { data: null, error: null } })
    expect(await isAccountFeatureEnabled(admin, 'acct-1', 'business_units_enabled')).toBe(false)
  })

  it('fails closed (false) for a nonexistent account — same "no row" shape', async () => {
    const admin = makeAdmin({ singleResult: { data: null, error: null } })
    expect(await isAccountFeatureEnabled(admin, 'ghost-acct', 'multi_connection_enabled')).toBe(
      false,
    )
  })

  it('fails closed (false) on a read error, without throwing', async () => {
    const admin = makeAdmin({ singleResult: { data: null, error: { message: 'db down' } } })
    await expect(
      isAccountFeatureEnabled(admin, 'acct-1', 'multi_connection_enabled'),
    ).resolves.toBe(false)
  })
})

describe('getAccountFeatureFlags', () => {
  it('returns a full map with every known key, defaulting to false when no rows exist', async () => {
    const admin = makeAdmin({ listResult: { data: [], error: null } })
    const result = await getAccountFeatureFlags(admin, 'acct-1')
    expect(result).toEqual({
      multi_connection_enabled: false,
      business_units_enabled: false,
    })
  })

  it('reflects enabled=true rows and leaves the rest at the false default', async () => {
    const admin = makeAdmin({
      listResult: {
        data: [{ feature_key: 'multi_connection_enabled', enabled: true }],
        error: null,
      },
    })
    const result = await getAccountFeatureFlags(admin, 'acct-1')
    expect(result.multi_connection_enabled).toBe(true)
    expect(result.business_units_enabled).toBe(false)
  })

  it('ignores an unknown feature_key defensively instead of throwing', async () => {
    const admin = makeAdmin({
      listResult: { data: [{ feature_key: 'some_future_key', enabled: true }], error: null },
    })
    const result = await getAccountFeatureFlags(admin, 'acct-1')
    expect(result).toEqual({
      multi_connection_enabled: false,
      business_units_enabled: false,
    })
  })

  it('fails closed to the all-false map on a read error', async () => {
    const admin = makeAdmin({ listResult: { data: null, error: { message: 'db down' } } })
    const result = await getAccountFeatureFlags(admin, 'acct-1')
    expect(result).toEqual({
      multi_connection_enabled: false,
      business_units_enabled: false,
    })
  })
})
