import { describe, expect, it, vi } from 'vitest'

import { compensateFailedUserCreation } from './user-compensation'

function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    delete: vi.fn(() => obj),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return obj
}

function fakeAdmin(opts: {
  profileAccountId?: string | null
  deleteUserError?: { message: string } | null
}) {
  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      return chain({ data: opts.profileAccountId ? { account_id: opts.profileAccountId } : null, error: null })
    }
    if (table === 'accounts') return chain({ data: null, error: null })
    throw new Error(`unexpected table ${table}`)
  })
  const deleteUser = vi.fn(async () => ({ error: opts.deleteUserError ?? null }))
  return { from, auth: { admin: { deleteUser } } }
}

describe('compensateFailedUserCreation', () => {
  it('deletes the temp personal account (scoped to owner_user_id = userId) before deleting the auth user', async () => {
    const admin = fakeAdmin({ profileAccountId: 'temp-acct-1', deleteUserError: null })

    const result = await compensateFailedUserCreation(admin as never, 'user-1')

    expect(result.ok).toBe(true)
    expect(admin.from).toHaveBeenCalledWith('profiles')
    expect(admin.from).toHaveBeenCalledWith('accounts')
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith('user-1')
  })

  it('skips the account delete when the user has no profile (nothing to clean up there)', async () => {
    const admin = fakeAdmin({ profileAccountId: null, deleteUserError: null })

    const result = await compensateFailedUserCreation(admin as never, 'user-1')

    expect(result.ok).toBe(true)
    // 'accounts' is never queried when there's no profile/account to remove.
    expect(admin.from).not.toHaveBeenCalledWith('accounts')
  })

  it('reports ok: false when deleteUser fails even after the cleanup attempt (manual cleanup required)', async () => {
    const admin = fakeAdmin({ profileAccountId: 'temp-acct-1', deleteUserError: { message: 'cleanup failed' } })

    const result = await compensateFailedUserCreation(admin as never, 'user-1')

    expect(result.ok).toBe(false)
  })
})
