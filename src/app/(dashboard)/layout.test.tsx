import { beforeEach, describe, expect, it, vi } from 'vitest'

// DashboardLayout wraps every (dashboard) route. It must redirect a
// deactivated tenant profile (profiles.is_active = false) to
// /account-disabled, and must NOT change behavior for any other
// failure mode from getCurrentAccount() — that's DashboardShell's own
// client-side job, unchanged by this gate.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`)
  }),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    getCurrentAccount: mocks.getCurrentAccount,
  }
})

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

// Stubbed out — this test is about the server-side gate, not the
// shell's own client rendering (which needs a browser to exercise).
vi.mock('./dashboard-shell', () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => children,
}))

import { AccountDisabledError, ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import DashboardLayout from './layout'

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.redirect.mockClear()
})

describe('DashboardLayout (is_active gate)', () => {
  it('redirects to /account-disabled when the profile is deactivated', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new AccountDisabledError())

    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      'REDIRECT:/account-disabled',
    )
    expect(mocks.redirect).toHaveBeenCalledWith('/account-disabled')
  })

  it('does NOT redirect on UnauthorizedError — leaves it to the existing client-side /login redirect', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError())

    const result = await DashboardLayout({ children: 'content' })

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })

  it('does NOT redirect on a generic ForbiddenError (e.g. orphaned profile) — unchanged pre-existing behavior', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new ForbiddenError('Profile is not linked to an account'))

    const result = await DashboardLayout({ children: 'content' })

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })

  it('renders the shell normally for an active user — no redirect', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'owner',
      account: { id: 'acct-1', name: 'Acme' },
    })

    const result = await DashboardLayout({ children: 'content' })

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })
})
