// ============================================================
// Checagem de status de conta (accounts.is_active) para código
// server-only que já usa service_role — motor de automações, runner
// de flows, webhook inbound do WhatsApp, cron, auto-reply de IA.
//
// Por que isso precisa existir separado de is_account_member()
// -----------------------------------------------------------
// is_account_member() (SQL, ver 047_platform_account_management.sql)
// já bloqueia acesso via RLS quando accounts.is_active = false, mas
// só é consultada em queries que passam por RLS — ou seja, o client
// RLS-scoped (browser ou getCurrentAccount()/requireRole() no
// servidor). Todo o código listado acima usa service_role
// deliberadamente (webhooks/cron não têm uma sessão de usuário para
// autenticar contra RLS), e service_role ignora RLS por definição.
// Isso significa que is_account_member() nunca é avaliada nesses
// caminhos — uma empresa desativada continuaria recebendo mensagens
// do WhatsApp, disparando automações/flows e gerando resposta
// automática de IA, mesmo com seus usuários humanos já bloqueados na
// UI. Este módulo é a checagem equivalente para esse mundo.
//
// Fail-closed: qualquer erro de leitura trata a conta como inativa
// (bloqueia o processamento) em vez de deixar passar — mesmo padrão
// já usado em getCurrentAccount() (src/lib/auth/account.ts) para
// falhas de leitura de accounts/profiles.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export async function isAccountActive(
  admin: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('accounts')
    .select('is_active')
    .eq('id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[isAccountActive] lookup failed for the target account')
    return false
  }

  return data?.is_active === true
}

/**
 * Checagem em lote para rotinas de cron que processam várias contas
 * numa só varredura (ex.: drenar automation_pending_executions) —
 * evita uma query por linha. Retorna o subconjunto de ids que estão
 * ativos; qualquer id não presente no resultado deve ser tratado
 * como inativo (inclui o caso de erro na leitura, tratado como
 * "nenhuma conta ativa" — fail closed).
 */
export async function getActiveAccountIds(
  admin: SupabaseClient,
  accountIds: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(accountIds))
  if (unique.length === 0) return new Set()

  const { data, error } = await admin
    .from('accounts')
    .select('id')
    .in('id', unique)
    .eq('is_active', true)

  if (error) {
    console.error('[getActiveAccountIds] batch lookup failed')
    return new Set()
  }

  return new Set((data ?? []).map((row) => row.id as string))
}
