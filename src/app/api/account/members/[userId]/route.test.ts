import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireRole: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}))

// PATCH usa requirePermission('users.edit') — para owner/admin/viewer
// o resultado é idêntico ao requireRole("admin") de antes
// (legacyHasPermission preserva o rank check). A garantia estrutural
// (self-target, alvo=owner, cross-account) vive dentro da RPC
// set_member_role (062_user_permission_overrides.sql), não é
// re-testável aqui sem um Postgres real — ver o bloco de VALIDAÇÃO
// MANUAL na migration.
//
// DELETE volta a usar requireRole("admin") puro — remoção de membro
// não faz parte do catálogo de overrides da FASE 1 (decisão explícita:
// não mexer em remove_account_member nem nas tabelas que ela
// referencia).
vi.mock('@/lib/auth/permission-guard', () => ({
  requirePermission: mocks.requirePermission,
}))

import { PATCH, DELETE } from './route'

const FORBIDDEN = Object.assign(new Error('Forbidden'), { status: 403 })

function makeCtx(role: string = 'admin') {
  return {
    userId: 'caller-1',
    accountId: 'acct-1',
    role,
    supabase: { rpc: mocks.rpc },
  }
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/account/members/target-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ userId: 'target-1' })

beforeEach(() => {
  mocks.requirePermission.mockReset()
  mocks.requireRole.mockReset()
  mocks.rpc.mockReset()
})

describe('PATCH /api/account/members/[userId] (users.edit)', () => {
  it('rejects an agent without a users.edit override', async () => {
    mocks.requirePermission.mockRejectedValue(FORBIDDEN)
    const res = await PATCH(patchRequest({ role: 'viewer' }), { params })
    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('an agent whose override permits users.edit calls the same RPC an admin would', async () => {
    mocks.requirePermission.mockResolvedValue(makeCtx('agent'))
    mocks.rpc.mockResolvedValue({ error: null })

    const res = await PATCH(patchRequest({ role: 'viewer' }), { params })

    expect(res.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith('users.edit')
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_role', {
      p_user_id: 'target-1',
      p_new_role: 'viewer',
    })
  })

  it("rejects role: 'owner' before ever reaching the RPC — promotion to owner only via transfer-ownership", async () => {
    mocks.requirePermission.mockResolvedValue(makeCtx())
    const res = await PATCH(patchRequest({ role: 'owner' }), { params })
    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('maps the RPC 42501 (e.g. self-target/owner-target guard tripped inside SQL) to a 403', async () => {
    mocks.requirePermission.mockResolvedValue(makeCtx())
    mocks.rpc.mockResolvedValue({ error: { code: '42501', message: 'This action requires the admin role or higher' } })

    const res = await PATCH(patchRequest({ role: 'agent' }), { params })
    expect(res.status).toBe(403)
  })

  it('maps the RPC 22023 (e.g. "Cannot change your own role") to a 400', async () => {
    mocks.requirePermission.mockResolvedValue(makeCtx())
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'Cannot change your own role' } })

    const res = await PATCH(patchRequest({ role: 'agent' }), { params })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/account/members/[userId] (admin+, sem override — fora da FASE 1)', () => {
  it('rejects a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(FORBIDDEN)
    const res = await DELETE(new Request('http://localhost'), { params })
    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('an admin/owner calls the RPC — no permission-guard involved at all', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx('admin'))
    mocks.rpc.mockResolvedValue({ data: 'new-personal-account-id', error: null })

    const res = await DELETE(new Request('http://localhost'), { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expect(mocks.requirePermission).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith('remove_account_member', { p_user_id: 'target-1' })
    expect(json.newPersonalAccountId).toBe('new-personal-account-id')
  })

  it('maps the RPC 22023 (e.g. "Cannot remove the account owner") to a 400', async () => {
    mocks.requireRole.mockResolvedValue(makeCtx())
    mocks.rpc.mockResolvedValue({ error: { code: '22023', message: 'Cannot remove the account owner; transfer ownership first' } })

    const res = await DELETE(new Request('http://localhost'), { params })
    expect(res.status).toBe(400)
  })
})
