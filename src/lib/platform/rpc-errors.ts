// ============================================================
// Mapeia SQLSTATEs conhecidos das RPCs de plataforma (ver
// supabase/migrations/046_platform_admin_foundation.sql e
// 047_platform_account_management.sql) para respostas HTTP
// sanitizadas. As próprias RPCs nunca incluem UUID de conta/usuário
// nas mensagens de erro — esta função também não adiciona nenhum.
// ============================================================

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

export function platformRpcErrorToResponse(
  err: PostgrestError,
  fallbackMessage: string,
): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 })
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
  if (err.code === '23505') {
    return NextResponse.json({ error: err.message }, { status: 409 })
  }
  console.error('[platform rpc] unexpected error:', err)
  return NextResponse.json({ error: fallbackMessage }, { status: 500 })
}
