// ============================================================
// Mapeia SQLSTATEs conhecidos das RPCs de plataforma (ver
// supabase/migrations/046_platform_admin_foundation.sql,
// 047_platform_account_management.sql e
// 048_platform_user_management.sql) para respostas HTTP
// sanitizadas. As próprias RPCs nunca incluem UUID de conta/usuário
// nas mensagens de erro — esta função também não adiciona nenhum.
//
// DIAGNÓSTICO (todas as branches, não só a inesperada): `code` e
// `message` já são exatamente o que é devolvido ao client em cada
// resposta 400/403/409 abaixo — logar os dois aqui não expõe nada
// que o próprio chamador não veja na resposta; só dá visibilidade do
// lado do servidor sobre QUAL validação da RPC disparou, sem precisar
// reproduzir manualmente toda vez. Nunca loga o objeto `err` inteiro
// (pode carregar detail/hint/query internos do Postgres).
// ============================================================

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

export function platformRpcErrorToResponse(
  err: PostgrestError,
  fallbackMessage: string,
): NextResponse {
  if (err.code === '42501') {
    console.error(`[platform rpc] 42501 forbidden (${fallbackMessage}):`, err.message)
    return NextResponse.json({ error: err.message }, { status: 403 })
  }
  if (err.code === '22023') {
    console.error(`[platform rpc] 22023 invalid input (${fallbackMessage}):`, err.message)
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
  if (err.code === '23505') {
    console.error(`[platform rpc] 23505 conflict (${fallbackMessage}):`, err.message)
    return NextResponse.json({ error: err.message }, { status: 409 })
  }
  console.error(`[platform rpc] unexpected error (${fallbackMessage}): code=${err.code}`, err.message)
  return NextResponse.json({ error: fallbackMessage }, { status: 500 })
}
