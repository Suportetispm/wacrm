import { beforeEach, describe, expect, it, vi } from 'vitest'

// AdminLayout is the real authorization boundary for /admin — it must
// call requirePlatformAdmin() and nothing else (never
// getCurrentAccount()/requireRole()), and redirect appropriately for
// each failure mode.

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`)
  }),
}))

vi.mock('@/lib/auth/platform-admin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/platform-admin')>(
    '@/lib/auth/platform-admin',
  )
  return {
    ...actual,
    requirePlatformAdmin: mocks.requirePlatformAdmin,
  }
})

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

// Stubbed out — this test is about the authorization gate, not the
// shell's own rendering (which needs a browser to exercise anyway).
vi.mock('@/components/admin/admin-shell', () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => children,
}))

import { PlatformForbiddenError, PlatformUnauthorizedError } from '@/lib/auth/platform-admin'
import AdminLayout from './layout'

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset()
  mocks.redirect.mockClear()
})

describe('AdminLayout (server gate)', () => {
  it('redirects to /login when there is no session at all', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new PlatformUnauthorizedError())

    await expect(AdminLayout({ children: null })).rejects.toThrow('REDIRECT:/login')
    expect(mocks.redirect).toHaveBeenCalledWith('/login')
  })

  it('redirects an authenticated-but-not-platform-admin user to /dashboard, not a bare 403', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new PlatformForbiddenError())

    await expect(AdminLayout({ children: null })).rejects.toThrow('REDIRECT:/dashboard')
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard')
  })

  it('renders the shell for a real platform admin — no redirect', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'super-1' })

    const result = await AdminLayout({ children: 'content' })

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })
})
