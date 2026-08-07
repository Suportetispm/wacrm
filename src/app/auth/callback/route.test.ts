import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
  }),
}))

import { GET } from './route'

function req(query: string) {
  return new Request(`https://app.example${query}`)
}

beforeEach(() => {
  mocks.exchangeCodeForSession.mockReset()
})

describe('GET /auth/callback', () => {
  it('valid code + allowed next: exchanges the code and redirects to /reset-password with the recovery cookie set', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(req('/auth/callback?code=abc123&next=/reset-password'))

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('abc123')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://app.example/reset-password')
    // never forwards the code/tokens into the final URL
    expect(res.headers.get('location')).not.toContain('code=')
    expect(res.cookies.get('sb-recovery-pending')?.value).toBe('1')
  })

  it('missing code: redirects to the generic error page without exchanging anything', async () => {
    const res = await GET(req('/auth/callback?next=/reset-password'))

    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('https://app.example/forgot-password?error=invalid_link')
    expect(res.cookies.get('sb-recovery-pending')).toBeUndefined()
  })

  it('exchange error: redirects to the generic error page, not the requested next', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: { message: 'invalid grant' } })
    const res = await GET(req('/auth/callback?code=bad&next=/reset-password'))

    expect(res.headers.get('location')).toBe('https://app.example/forgot-password?error=invalid_link')
    expect(res.cookies.get('sb-recovery-pending')).toBeUndefined()
  })

  it('external next is rejected — falls back to /login, not the attacker URL', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(req('/auth/callback?code=abc123&next=https://evil.example'))

    expect(res.headers.get('location')).toBe('https://app.example/login')
    expect(res.cookies.get('sb-recovery-pending')).toBeUndefined()
  })

  it('protocol-relative next is rejected', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(req('/auth/callback?code=abc123&next=%2F%2Fevil.example'))

    expect(res.headers.get('location')).toBe('https://app.example/login')
  })

  it('javascript: next is rejected', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(req('/auth/callback?code=abc123&next=javascript%3Aalert(1)'))

    expect(res.headers.get('location')).toBe('https://app.example/login')
  })

  it('no next param at all defaults to /login', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(req('/auth/callback?code=abc123'))

    expect(res.headers.get('location')).toBe('https://app.example/login')
    expect(res.cookies.get('sb-recovery-pending')).toBeUndefined()
  })
})
