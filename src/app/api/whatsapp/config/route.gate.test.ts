import { beforeEach, describe, expect, it, vi } from 'vitest'

// ETAPA 078-0 — POST /api/whatsapp/config (Meta save). With no Meta row
// yet, the save becomes an INSERT, i.e. a NEW connection (possibly next
// to an existing UAZAPI one) — gated by multi_connection_enabled, and
// checked before any Meta call. Updating the existing Meta row is
// maintenance and never consults the gate.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  checkNewConnectionAllowed: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: mocks.requireRole }
})

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  registerPhoneNumber: mocks.registerPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v),
}))

vi.mock('@/lib/whatsapp/connection-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/connection-gate')>()
  return { ...actual, checkNewConnectionAllowed: mocks.checkNewConnectionAllowed }
})

// Module-local service-role client in route.ts — only used for the
// "phone_number_id claimed by another account" check.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    const b: Record<string, unknown> = {}
    b.from = vi.fn(() => b)
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.neq = vi.fn(() => b)
    b.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
    return b
  }),
}))

import { POST } from './route'

function sessionClient(existingMetaRow: Record<string, unknown> | null) {
  return {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.order = vi.fn(() => b)
      b.limit = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => ({ data: existingMetaRow, error: null }))
      b.insert = vi.fn(async (payload: unknown) => {
        mocks.insert(payload)
        return { error: null }
      })
      b.update = vi.fn((payload: unknown) => {
        mocks.update(payload)
        return { eq: vi.fn(async () => ({ error: null })) }
      })
      return b
    }),
  }
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const BODY = { phone_number_id: 'pn-1', access_token: 'tok' }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.verifyPhoneNumber.mockResolvedValue({ display_phone_number: '+1' })
})

describe('POST /api/whatsapp/config — ETAPA 078-0 multi-connection gate', () => {
  it('no connection yet (gate allows): first Meta connection is inserted', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: sessionClient(null), userId: 'u1', accountId: 'acct-1' })
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: true,
      connectionCount: 0,
      multiConnectionEnabled: false,
    })

    const res = await POST(postRequest(BODY))

    expect(res.status).toBe(200)
    expect(mocks.checkNewConnectionAllowed).toHaveBeenCalledWith(expect.anything(), 'acct-1')
    expect(mocks.insert).toHaveBeenCalledTimes(1)
  })

  it('UAZAPI already exists + flag off: parallel Meta insert blocked before any Meta call', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: sessionClient(null), userId: 'u1', accountId: 'acct-1' })
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'multi_connection_disabled',
      connectionCount: 1,
    })

    const res = await POST(postRequest(BODY))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('multi_connection_disabled')
    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.registerPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('UAZAPI already exists + flag on: parallel Meta connection is inserted', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: sessionClient(null), userId: 'u1', accountId: 'acct-1' })
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: true,
      connectionCount: 1,
      multiConnectionEnabled: true,
    })

    const res = await POST(postRequest(BODY))

    expect(res.status).toBe(200)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
  })

  it('gate lookup failure fails closed: 500, no Meta call, nothing written', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: sessionClient(null), userId: 'u1', accountId: 'acct-1' })
    mocks.checkNewConnectionAllowed.mockResolvedValue({ allowed: false, reason: 'lookup_failed' })

    const res = await POST(postRequest(BODY))

    expect(res.status).toBe(500)
    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('editing the existing Meta connection never consults the gate and still updates it', async () => {
    const existing = { id: 'cfg-meta', registered_at: '2026-01-01', phone_number_id: 'pn-1' }
    mocks.requireRole.mockResolvedValue({ supabase: sessionClient(existing), userId: 'u1', accountId: 'acct-1' })
    // Would block if it were ever consulted.
    mocks.checkNewConnectionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'multi_connection_disabled',
      connectionCount: 2,
    })

    const res = await POST(postRequest(BODY))

    expect(res.status).toBe(200)
    expect(mocks.checkNewConnectionAllowed).not.toHaveBeenCalled()
    expect(mocks.verifyPhoneNumber).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
