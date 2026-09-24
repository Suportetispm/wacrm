// ============================================================
// Leitura de account_feature_flags (071_account_feature_flags.sql)
// para código server-only que já usa service_role — mesmo público-
// alvo de isAccountActive() (./active.ts): webhooks, motor de flows,
// motor de automações, auto-reply de IA, e qualquer rota futura que
// precise decidir "esta conta tem a feature X habilitada?" fora de
// uma sessão RLS-scoped.
//
// A tabela não tem nenhuma policy de RLS para authenticated/anon
// (só platform_set_account_feature, SECURITY DEFINER, escreve nela) —
// por isso toda leitura aqui passa por um client admin (service_role),
// recebido como parâmetro em vez de criado internamente, no mesmo
// estilo de isAccountActive()/getActiveAccountIds().
//
// Fail-closed: ausência de linha, conta inexistente, ou qualquer erro
// de leitura tratam a feature como DESABILITADA — nunca o contrário.
// Isso é o que garante que nenhuma conta muda de comportamento antes
// de uma linha explícita ser criada via platform_set_account_feature.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const ACCOUNT_FEATURE_KEYS = [
  'multi_connection_enabled',
  'business_units_enabled',
] as const

export type AccountFeatureKey = (typeof ACCOUNT_FEATURE_KEYS)[number]

export function isAccountFeatureKey(value: unknown): value is AccountFeatureKey {
  return typeof value === 'string' && (ACCOUNT_FEATURE_KEYS as readonly string[]).includes(value)
}

/**
 * Uma única feature de uma conta. Ausência de linha, ou erro de
 * leitura, resolvem para `false` — nunca lança.
 */
export async function isAccountFeatureEnabled(
  admin: SupabaseClient,
  accountId: string,
  featureKey: AccountFeatureKey,
): Promise<boolean> {
  const { data, error } = await admin
    .from('account_feature_flags')
    .select('enabled')
    .eq('account_id', accountId)
    .eq('feature_key', featureKey)
    .maybeSingle()

  if (error) {
    console.error('[isAccountFeatureEnabled] lookup failed for the target account/feature')
    return false
  }

  return data?.enabled === true
}

/**
 * Todas as feature flags conhecidas de uma conta, como um mapa
 * completo (toda chave de ACCOUNT_FEATURE_KEYS sempre presente,
 * mesmo sem linha gravada — default `false`). Útil para uma rota que
 * precisa decidir várias features de uma vez em uma única query, em
 * vez de uma chamada por chave.
 */
export async function getAccountFeatureFlags(
  admin: SupabaseClient,
  accountId: string,
): Promise<Record<AccountFeatureKey, boolean>> {
  const flags = Object.fromEntries(
    ACCOUNT_FEATURE_KEYS.map((key) => [key, false]),
  ) as Record<AccountFeatureKey, boolean>

  const { data, error } = await admin
    .from('account_feature_flags')
    .select('feature_key, enabled')
    .eq('account_id', accountId)

  if (error) {
    console.error('[getAccountFeatureFlags] batch lookup failed for the target account')
    return flags
  }

  for (const row of (data ?? []) as { feature_key: string; enabled: boolean }[]) {
    if (isAccountFeatureKey(row.feature_key) && row.enabled === true) {
      flags[row.feature_key] = true
    }
  }

  return flags
}
