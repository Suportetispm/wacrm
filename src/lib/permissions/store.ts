// ============================================================
// Persistência de user_permission_overrides
// (062_user_permission_overrides.sql). Server-only — toda função
// aqui passa pelo client service-role (admin-client.ts) porque a
// tabela não tem policies de RLS para authenticated/anon.
//
// Ausência de uma linha para (account_id, user_id, permission_key)
// sempre significa Herdar — os chamadores é que mapeiam isso para
// AGENT_PERMISSION_DEFAULTS (ver permission-guard.ts). Este módulo
// nunca aplica um default sozinho, só reflete o que está gravado.
// ============================================================

import { supabaseAdmin } from './admin-client';
import { PERMISSION_KEYS, type PermissionKey } from '@/lib/auth/permissions';

interface OverrideRow {
  permission_key: PermissionKey;
  allowed: boolean;
}

/**
 * Todas as linhas de override de um par (account, user), como um Map
 * indexado pela chave de permissão. Chaves ausentes significam
 * Herdar para aquela chave.
 */
export async function loadOverridesForUser(
  accountId: string,
  userId: string,
): Promise<Map<PermissionKey, boolean>> {
  const { data, error } = await supabaseAdmin()
    .from('user_permission_overrides')
    .select('permission_key, allowed')
    .eq('account_id', accountId)
    .eq('user_id', userId);

  if (error) {
    console.error('[permissions/store] loadOverridesForUser failed:', error.code ?? error.message);
    // Falha fechada: em erro de leitura, trata toda chave como "sem
    // override" (Herdar) em vez de propagar um 500 através de toda
    // rota que chama requirePermission() — o chamador cai em
    // AGENT_PERMISSION_DEFAULTS, que para toda chave administrativa
    // é `false`, o resultado de menor privilégio.
    return new Map();
  }

  const map = new Map<PermissionKey, boolean>();
  for (const row of (data ?? []) as OverrideRow[]) {
    map.set(row.permission_key, row.allowed);
  }
  return map;
}

/** Atalho para uma única chave sobre `loadOverridesForUser`. */
export async function loadOverride(
  accountId: string,
  userId: string,
  key: PermissionKey,
): Promise<boolean | undefined> {
  const overrides = await loadOverridesForUser(accountId, userId);
  return overrides.get(key);
}

/**
 * Faz upsert ou limpa um conjunto de overrides para um par (account,
 * user). `value === null` limpa a linha (Herdar); `true`/`false` faz
 * upsert de Permitir/Bloquear. Usado só pela rota de escrita do
 * Superadmin (requirePlatformAdmin()) — nunca alcançável a partir de
 * uma rota de tenant.
 */
export async function setOverrides(
  accountId: string,
  userId: string,
  changes: Partial<Record<PermissionKey, boolean | null>>,
  updatedByUserId: string,
): Promise<void> {
  const admin = supabaseAdmin();

  const toDelete: PermissionKey[] = [];
  const toUpsert: { account_id: string; user_id: string; permission_key: PermissionKey; allowed: boolean; created_by_user_id: string }[] = [];

  for (const key of PERMISSION_KEYS) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (value === null || value === undefined) {
      toDelete.push(key);
    } else {
      toUpsert.push({
        account_id: accountId,
        user_id: userId,
        permission_key: key,
        allowed: value,
        created_by_user_id: updatedByUserId,
      });
    }
  }

  if (toDelete.length > 0) {
    const { error } = await admin
      .from('user_permission_overrides')
      .delete()
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .in('permission_key', toDelete);
    if (error) throw error;
  }

  if (toUpsert.length > 0) {
    const { error } = await admin
      .from('user_permission_overrides')
      .upsert(toUpsert, { onConflict: 'account_id,user_id,permission_key' });
    if (error) throw error;
  }
}

/** Apaga toda linha de override de um par (account, user) — "Restaurar permissões padrão". */
export async function resetOverrides(accountId: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('user_permission_overrides')
    .delete()
    .eq('account_id', accountId)
    .eq('user_id', userId);
  if (error) throw error;
}
