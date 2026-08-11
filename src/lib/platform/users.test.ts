import { describe, expect, it, vi } from 'vitest'

import { fetchPlatformUser, isManagedAccountRole } from './users'

// Minimal fake Supabase query-builder: every filter method returns
// itself so chains of arbitrary length work, `.maybeSingle()` and a
// bare `await` (via `.then`) both resolve to the configured result.
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}

function fakeAdmin(byTable: Record<string, unknown>) {
  return { from: vi.fn((table: string) => byTable[table]) }
}

describe('isManagedAccountRole', () => {
  it('accepts admin and agent', () => {
    expect(isManagedAccountRole('admin')).toBe(true)
    expect(isManagedAccountRole('agent')).toBe(true)
  })

  it('rejects owner, viewer and garbage', () => {
    expect(isManagedAccountRole('owner')).toBe(false)
    expect(isManagedAccountRole('viewer')).toBe(false)
    expect(isManagedAccountRole('supervisor')).toBe(false)
    expect(isManagedAccountRole(null)).toBe(false)
    expect(isManagedAccountRole(undefined)).toBe(false)
  })
})

describe('fetchPlatformUser', () => {
  it('returns null when the profile does not exist', async () => {
    const admin = fakeAdmin({ profiles: chain({ data: null, error: null }) })
    const result = await fetchPlatformUser(admin as never, 'user-1')
    expect(result).toBeNull()
  })

  it('returns null for an owner profile — not managed by this surface', async () => {
    const admin = fakeAdmin({
      profiles: chain({
        data: { user_id: 'user-1', account_role: 'owner', full_name: 'X', email: 'x@x.com', account_id: 'acct-1', is_active: true, created_at: 'now' },
        error: null,
      }),
    })
    const result = await fetchPlatformUser(admin as never, 'user-1')
    expect(result).toBeNull()
  })

  it('returns null for a viewer profile — not managed by this surface', async () => {
    const admin = fakeAdmin({
      profiles: chain({
        data: { user_id: 'user-1', account_role: 'viewer', full_name: 'X', email: 'x@x.com', account_id: 'acct-1', is_active: true, created_at: 'now' },
        error: null,
      }),
    })
    const result = await fetchPlatformUser(admin as never, 'user-1')
    expect(result).toBeNull()
  })

  it('returns null when the profile points at an account that cannot be loaded', async () => {
    const admin = fakeAdmin({
      profiles: chain({
        data: { user_id: 'user-1', account_role: 'agent', full_name: 'X', email: 'x@x.com', account_id: 'acct-1', is_active: true, created_at: 'now' },
        error: null,
      }),
      accounts: chain({ data: null, error: null }),
    })
    const result = await fetchPlatformUser(admin as never, 'user-1')
    expect(result).toBeNull()
  })

  it('assembles the sanitized shape, including queues, for a managed agent profile', async () => {
    const admin = fakeAdmin({
      profiles: chain({
        data: {
          user_id: 'user-1',
          account_role: 'agent',
          full_name: 'Jane Doe',
          email: 'jane@acme.com',
          account_id: 'acct-1',
          is_active: true,
          created_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      }),
      accounts: chain({ data: { id: 'acct-1', name: 'Acme' }, error: null }),
      queue_members: chain({ data: [{ queue_id: 'q1' }, { queue_id: 'q2' }], error: null }),
      queues: chain({
        data: [
          { id: 'q1', name: 'Suporte', color: '#fff' },
          { id: 'q2', name: 'Comercial', color: '#000' },
        ],
        error: null,
      }),
    })

    const result = await fetchPlatformUser(admin as never, 'user-1')

    expect(result).toEqual({
      id: 'user-1',
      full_name: 'Jane Doe',
      email: 'jane@acme.com',
      account: { id: 'acct-1', name: 'Acme' },
      account_role: 'agent',
      is_active: true,
      queues: [
        { id: 'q1', name: 'Suporte', color: '#fff' },
        { id: 'q2', name: 'Comercial', color: '#000' },
      ],
      created_at: '2026-01-01T00:00:00Z',
    })
  })

  it('returns an empty queues array (never null/undefined) when the user has no queue memberships', async () => {
    const admin = fakeAdmin({
      profiles: chain({
        data: {
          user_id: 'user-1',
          account_role: 'admin',
          full_name: 'Jane Doe',
          email: 'jane@acme.com',
          account_id: 'acct-1',
          is_active: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      }),
      accounts: chain({ data: { id: 'acct-1', name: 'Acme' }, error: null }),
      queue_members: chain({ data: [], error: null }),
    })

    const result = await fetchPlatformUser(admin as never, 'user-1')
    expect(result?.queues).toEqual([])
    expect(result?.is_active).toBe(false)
  })
})
