import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cookiesGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`)
  }),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookiesGet }),
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

// The gate must not depend on the client form actually rendering —
// stub it out so this stays a pure server-logic test.
vi.mock('@/components/auth/reset-password-form', () => ({
  ResetPasswordForm: () => null,
}))

import ResetPasswordPage from './page'

beforeEach(() => {
  mocks.cookiesGet.mockReset()
  mocks.redirect.mockClear()
})

describe('ResetPasswordPage (server gate)', () => {
  it('D: redirects to /forgot-password with a generic error when the recovery cookie is missing', async () => {
    mocks.cookiesGet.mockReturnValue(undefined)
    await expect(ResetPasswordPage()).rejects.toThrow('REDIRECT:/forgot-password?error=invalid_link')
    expect(mocks.redirect).toHaveBeenCalledWith('/forgot-password?error=invalid_link')
  })

  it('renders the form when the recovery cookie is present', async () => {
    mocks.cookiesGet.mockReturnValue({ value: '1' })
    const result = await ResetPasswordPage()
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })
})
