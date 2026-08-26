import { beforeEach, describe, expect, it, vi } from 'vitest'

// Correção de segurança sob teste: POST /api/whatsapp/broadcast antes só
// checava `supabase.auth.getUser()` + resolvia account_id, nunca o
// account_role do chamador — qualquer membro autenticado, inclusive um
// `viewer`, conseguia disparar um broadcast chamando a rota direto. A
// correção troca aquele bloco manual de auth por `requireRole('agent')`,
// espelhando toda rota de escrita irmã (automations, flows, quick-replies).

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}))

// Mock parcial — mantém o ForbiddenError/toErrorResponse reais para que
// este teste exercite exatamente as classes/mapeamento que a rota usa em
// produção, só substituindo a resolução de requireRole.
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: mocks.requireRole }
})

import { ForbiddenError } from '@/lib/auth/account'

import { POST } from './route'

function request(body: unknown = {}) {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
})

describe('POST /api/whatsapp/broadcast', () => {
  it('rejects a viewer with 403 — viewers are read-only, cannot dispatch a broadcast', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError("This action requires the 'agent' role or higher"),
    )

    const res = await POST(request({ template_name: 'hello' }))

    expect(res.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
  })

  it('proceeds past the guard for an agent — reaches the request-body validation, not the auth check', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: 'not configured' } }),
            }),
          }),
        }),
      },
      userId: 'user-1',
      accountId: 'account-1',
      role: 'agent',
      account: { id: 'account-1', name: 'Acme' },
    })

    // Sem template_name — a própria validação 400 da rota, provando
    // que a execução passou do guard de papel para um chamador autorizado.
    const res = await POST(request({ phone_numbers: ['+15550001111'] }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/template_name/i)
  })
})
