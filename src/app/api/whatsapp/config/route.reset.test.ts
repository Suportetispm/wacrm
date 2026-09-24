import { beforeEach, describe, expect, it, vi } from 'vitest'

// ETAPA 078A-PREP — "Reset Configuration" (DELETE /api/whatsapp/config)
// keeps its hard delete for a connection with no history, but once 078A
// makes conversations reference the connection (FK NO ACTION) the
// delete is refused by the DB. That must surface as a clear 409, not a
// generic 500 — recovery is re-entering the credentials (POST updates
// the same row in place).

const mocks = vi.hoisted(() => ({
  deleteResult: { error: null as { code?: string; message: string } | null },
  loadPrimaryWhatsAppConfigRow: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const b: Record<string, unknown> = {}
    b.auth = { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } }, error: null })) }
    b.from = vi.fn(() => b)
    b.select = vi.fn(() => b)
    b.eq = vi.fn((col: string) => (col === 'id' ? Promise.resolve(mocks.deleteResult) : b))
    b.delete = vi.fn(() => b)
    b.maybeSingle = vi.fn(async () => ({ data: { account_id: 'acct-1' }, error: null }))
    return b
  }),
}))

vi.mock('@/lib/whatsapp/active-config', () => ({
  loadPrimaryWhatsAppConfigRow: mocks.loadPrimaryWhatsAppConfigRow,
}))

import { DELETE } from './route'

beforeEach(() => {
  mocks.deleteResult.error = null
  mocks.loadPrimaryWhatsAppConfigRow.mockReset()
  mocks.loadPrimaryWhatsAppConfigRow.mockResolvedValue({ id: 'cfg-1' })
})

describe('DELETE /api/whatsapp/config (Reset Configuration)', () => {
  it('still hard-deletes a connection with no history', async () => {
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('maps 23503 (connection referenced by conversations) to 409 connection_has_history', async () => {
    mocks.deleteResult.error = { code: '23503', message: 'violates foreign key constraint' }
    const res = await DELETE()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe('connection_has_history')
  })

  it('any other delete error is still a 500', async () => {
    mocks.deleteResult.error = { code: '42501', message: 'denied' }
    const res = await DELETE()
    expect(res.status).toBe(500)
  })
})
