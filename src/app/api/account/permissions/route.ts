// ============================================================
// GET /api/account/permissions
//
// Devolve as permissões efetivas do PRÓPRIO chamador autenticado —
// nunca de outro usuário (isso é o editor do Superadmin, em
// /api/admin/users/[id]/permissions). Consumido pelo sidebar/rail
// (src/hooks/use-auth.tsx) para decidir o que mostrar para um agent;
// owner/admin/viewer não precisam desta chamada — seu comportamento
// já é 100% determinado por account_role_enum.
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getEffectivePermissions } from '@/lib/auth/permission-guard'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const permissions = await getEffectivePermissions(ctx)
    return NextResponse.json({ permissions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
