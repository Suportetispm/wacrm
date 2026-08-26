// ============================================================
// Overrides individuais de permissão — puro, testável sem I/O.
//
// FASE 1: restrito a `account_role = 'agent'`. owner/admin/viewer
// NUNCA são governados por este módulo — seu acesso continua vindo
// exclusivamente de `account_role_enum` via `hasMinRole()` (roles.ts).
// O Superadmin de plataforma (`platform_admins`, platform-admin.ts) é
// um mecanismo totalmente separado; `superadmin.access` deliberadamente
// não existe em nenhum lugar deste catálogo.
//
// Espelha o lado Postgres: o CHECK constraint em
// `user_permission_overrides.permission_key`
// (062_user_permission_overrides.sql) aceita exatamente estes 12
// valores, e `AGENT_PERMISSION_DEFAULTS` aqui corresponde ao piso
// "linha ausente = false" de `agent_has_permission_override`, usado
// pelas duas chaves administrativas que a mesma migration passa a
// consultar dentro de `create_account_member` / `set_member_role`.
// `remove_account_member` (remoção de membro da conta) NÃO faz parte
// desta fase — continua exclusivamente a definição de migration 018,
// sem override individual; ver AGENTS/histórico de decisão.
//
// Ausência de uma linha de override = Herdar → cai no default de
// `AGENT_PERMISSION_DEFAULTS`. A coluna `allowed` de uma linha é a
// palavra final: true = Permitir, false = Bloquear.
// ============================================================

import { hasMinRole, type AccountRole } from './roles';

export type PermissionKey =
  | 'users.view'
  | 'users.create'
  | 'users.edit'
  | 'queues.view'
  | 'queues.manage'
  | 'flows.view'
  | 'flows.manage'
  | 'flows.activate'
  | 'automations.view'
  | 'automations.manage'
  | 'quick_replies.view'
  | 'quick_replies.manage';

/** Toda chave de permissão válida — fonte única de verdade da qual o
 *  CHECK constraint do banco, a UI do editor no Superadmin e a
 *  validação da rota de escrita de overrides derivam. */
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'users.view',
  'users.create',
  'users.edit',
  'queues.view',
  'queues.manage',
  'flows.view',
  'flows.manage',
  'flows.activate',
  'automations.view',
  'automations.manage',
  'quick_replies.view',
  'quick_replies.manage',
] as const;

/** Estreita uma string desconhecida para um `PermissionKey` válido. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return (
    typeof value === 'string' &&
    (PERMISSION_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Valor efetivo default para um `agent` sem linha de override para
 * aquela chave. Deliberadamente mais restritivo que o comportamento
 * pré-FASE-1 para `users.*` e `queues.*` — ver os dois blocos `false`
 * abaixo — e inalterado para flows/automations/quick_replies, que
 * mantêm exatamente a capacidade atual do agent por default.
 */
export const AGENT_PERMISSION_DEFAULTS: Record<PermissionKey, boolean> = {
  'users.view': false,
  'users.create': false,
  'users.edit': false,

  'queues.view': false,
  'queues.manage': false,

  'flows.view': true,
  'flows.manage': true,
  'flows.activate': true,

  'automations.view': true,
  'automations.manage': true,

  'quick_replies.view': true,
  'quick_replies.manage': true,
};

/**
 * Papel mínimo que cada chave exigia *antes* da FASE 1, para as rotas
 * que já tinham algum gate de papel. `undefined` significa que a rota
 * não tinha gate nenhum antes da FASE 1 (qualquer membro da conta
 * conseguia chamar) — toda chave `.view` cai nesse balde hoje.
 *
 * Isto só é consultado para owner/admin/viewer (ver
 * `legacyHasPermission` abaixo) — um `agent` nunca toca nesta tabela,
 * ele segue o caminho override-ou-default. Manter esta tabela é o que
 * garante zero regressão de comportamento para os três papéis que esta
 * feature nunca teve a intenção de tocar.
 */
const LEGACY_MIN_ROLE: Partial<Record<PermissionKey, AccountRole>> = {
  'users.create': 'admin',
  'users.edit': 'admin',

  'queues.manage': 'admin',

  'flows.manage': 'agent',
  'flows.activate': 'agent',

  'automations.manage': 'agent',

  'quick_replies.manage': 'agent',
};

/**
 * A checagem de rank pré-FASE-1 para uma dada chave. Usada para
 * owner/admin/viewer — papéis que o sistema de overrides nunca
 * governa — de forma que o comportamento deles depois desta feature
 * seja comprovadamente idêntico ao de antes dela.
 */
export function legacyHasPermission(role: AccountRole, key: PermissionKey): boolean {
  const min = LEGACY_MIN_ROLE[key];
  return min ? hasMinRole(role, min) : true;
}
