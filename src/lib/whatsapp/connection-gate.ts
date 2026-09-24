import type { SupabaseClient } from '@supabase/supabase-js'
import { isAccountFeatureEnabled } from '@/lib/accounts/feature-flags'

// ============================================================
// Gate temporário de multiconexão (ETAPA 078-0).
//
// O banco já aceita várias whatsapp_config por account (077), mas o
// resto do sistema ainda não: conversations não guardam a conexão de
// origem e todo outbound sai pela conexão primária da account. Uma 2ª
// conexão criada agora faria mensagens que entram pelo número B serem
// respondidas pelo número A.
//
// Regra: criar uma conexão NOVA só é permitido quando a account ainda
// não tem nenhuma, ou quando `multi_connection_enabled` está ligada.
// Nunca se aplica a manutenção/edição/status/connect de uma conexão
// que já existe — só a quem vai INSERIR uma linha nova.
//
// Fail-closed: erro ao contar conexões bloqueia; erro/ausência da flag
// resolve para desligada (ver isAccountFeatureEnabled).
//
// Recebe o client admin (service_role) como parâmetro: a contagem não
// pode depender de RLS e account_feature_flags não tem policy para
// authenticated.
// ============================================================

export const MULTI_CONNECTION_DISABLED_CODE = 'multi_connection_disabled'
export const MULTI_CONNECTION_DISABLED_MESSAGE =
  'Multiple WhatsApp connections are not enabled for this account.'

export type NewConnectionGate =
  | { allowed: true; connectionCount: number; multiConnectionEnabled: boolean }
  | { allowed: false; reason: 'multi_connection_disabled'; connectionCount: number }
  | { allowed: false; reason: 'lookup_failed' }

export async function checkNewConnectionAllowed(
  admin: SupabaseClient,
  accountId: string,
): Promise<NewConnectionGate> {
  const { count, error } = await admin
    .from('whatsapp_config')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)

  if (error || count === null) {
    console.error('[connection-gate] whatsapp_config count failed for the target account')
    return { allowed: false, reason: 'lookup_failed' }
  }

  const multiConnectionEnabled = await isAccountFeatureEnabled(
    admin,
    accountId,
    'multi_connection_enabled',
  )

  if (count === 0 || multiConnectionEnabled) {
    return { allowed: true, connectionCount: count, multiConnectionEnabled }
  }
  return { allowed: false, reason: 'multi_connection_disabled', connectionCount: count }
}
