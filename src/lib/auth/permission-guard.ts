// ============================================================
// requirePermission() / getEffectivePermissions() — o único lugar
// que decide "este membro da conta pode fazer X", para as 12 chaves
// de permissions.ts.
//
// Convenção de chamada (espelha requireRole(min) de ./account):
//
//   try {
//     const ctx = await requirePermission('flows.manage');
//     // ctx.supabase / ctx.userId / ctx.accountId / ctx.role — o
//     // mesmo AccountContext que requireRole() já retorna.
//   } catch (err) {
//     return toErrorResponse(err);
//   }
//
// Regra (este é TODO o modelo de autorização da FASE 1 — não
// duplicar isto inline em uma rota):
//
//   role !== 'agent'  → legacyHasPermission(role, key)
//                        (owner/admin/viewer nunca consultam
//                        user_permission_overrides — seu
//                        comportamento é exatamente o mesmo de antes
//                        desta feature)
//   role === 'agent'  → linha de override para (accountId, userId,
//                        key) ?? AGENT_PERMISSION_DEFAULTS[key]
// ============================================================

import { getCurrentAccount, ForbiddenError, type AccountContext } from './account';
import {
  AGENT_PERMISSION_DEFAULTS,
  legacyHasPermission,
  PERMISSION_KEYS,
  type PermissionKey,
} from './permissions';
import { loadOverride, loadOverridesForUser } from '@/lib/permissions/store';

/** Permitir/bloquear efetivo para uma chave, com o contexto já resolvido. */
export async function hasPermission(ctx: AccountContext, key: PermissionKey): Promise<boolean> {
  if (ctx.role !== 'agent') {
    return legacyHasPermission(ctx.role, key);
  }
  const override = await loadOverride(ctx.accountId, ctx.userId, key);
  return override ?? AGENT_PERMISSION_DEFAULTS[key];
}

/**
 * Resolve o contexto de conta do chamador e aplica uma permissão.
 * Lança os mesmos `UnauthorizedError` / `ForbiddenError` /
 * `AccountDisabledError` de `getCurrentAccount()`, mais
 * `ForbiddenError("This action requires the '<key>' permission")`
 * quando o valor efetivo é false.
 */
export async function requirePermission(key: PermissionKey): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  const allowed = await hasPermission(ctx, key);
  if (!allowed) {
    throw new ForbiddenError(`This action requires the '${key}' permission`);
  }
  return ctx;
}

/**
 * Valor efetivo de toda chave para um contexto — uma única consulta
 * (não uma por chave). Usado por GET /api/account/permissions (as
 * permissões efetivas do próprio chamador, consumidas pelo
 * sidebar/rail) e pelo editor do Superadmin (permissões efetivas de
 * um usuário-alvo, junto com seus overrides brutos).
 */
export async function getEffectivePermissions(
  ctx: Pick<AccountContext, 'role' | 'accountId' | 'userId'>,
): Promise<Record<PermissionKey, boolean>> {
  if (ctx.role !== 'agent') {
    return Object.fromEntries(
      PERMISSION_KEYS.map((key) => [key, legacyHasPermission(ctx.role, key)]),
    ) as Record<PermissionKey, boolean>;
  }
  const overrides = await loadOverridesForUser(ctx.accountId, ctx.userId);
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, overrides.get(key) ?? AGENT_PERMISSION_DEFAULTS[key]]),
  ) as Record<PermissionKey, boolean>;
}
