import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadOverride: vi.fn(),
  loadOverridesForUser: vi.fn(),
}));

vi.mock('./account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./account')>();
  return { ...actual, getCurrentAccount: mocks.getCurrentAccount };
});

vi.mock('@/lib/permissions/store', () => ({
  loadOverride: mocks.loadOverride,
  loadOverridesForUser: mocks.loadOverridesForUser,
}));

import { getEffectivePermissions, hasPermission, requirePermission } from './permission-guard';
import { ForbiddenError } from './account';
import type { AccountRole } from './roles';

function ctx(role: AccountRole, overrides: Partial<{ accountId: string; userId: string }> = {}) {
  return {
    role,
    accountId: overrides.accountId ?? 'acct-1',
    userId: overrides.userId ?? 'user-1',
    supabase: {} as never,
    account: { id: 'acct-1', name: 'Acme' },
  };
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset();
  mocks.loadOverride.mockReset();
  mocks.loadOverridesForUser.mockReset();
});

describe('hasPermission — owner/admin/viewer never touch the override table', () => {
  it('owner/admin/viewer resolve purely from legacyHasPermission, without calling loadOverride', async () => {
    for (const role of ['owner', 'admin', 'viewer'] as const) {
      const allowed = await hasPermission(ctx(role), 'queues.manage');
      expect(allowed).toBe(role !== 'viewer');
    }
    expect(mocks.loadOverride).not.toHaveBeenCalled();
  });
});

describe('hasPermission — agent: override ?? default', () => {
  it('Herdar (no override row) falls back to AGENT_PERMISSION_DEFAULTS', async () => {
    mocks.loadOverride.mockResolvedValue(undefined);
    expect(await hasPermission(ctx('agent'), 'users.view')).toBe(false);
    expect(await hasPermission(ctx('agent'), 'flows.view')).toBe(true);
  });

  it('Permitir (allowed=true) overrides a false default', async () => {
    mocks.loadOverride.mockResolvedValue(true);
    expect(await hasPermission(ctx('agent'), 'users.create')).toBe(true);
  });

  it('Bloquear (allowed=false) overrides a true default', async () => {
    mocks.loadOverride.mockResolvedValue(false);
    expect(await hasPermission(ctx('agent'), 'flows.manage')).toBe(false);
  });

  it('queries the override scoped to this exact (accountId, userId, key)', async () => {
    mocks.loadOverride.mockResolvedValue(true);
    await hasPermission(ctx('agent', { accountId: 'acct-9', userId: 'user-9' }), 'queues.manage');
    expect(mocks.loadOverride).toHaveBeenCalledWith('acct-9', 'user-9', 'queues.manage');
  });
});

describe('requirePermission', () => {
  it('resolves the context when the permission is allowed', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('admin'));
    const result = await requirePermission('users.create');
    expect(result.role).toBe('admin');
  });

  it('throws ForbiddenError when denied', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('viewer'));
    await expect(requirePermission('flows.manage')).rejects.toThrow(ForbiddenError);
  });

  it('propagates whatever getCurrentAccount itself throws (Unauthorized, AccountDisabled)', async () => {
    const err = new Error('Unauthorized');
    mocks.getCurrentAccount.mockRejectedValue(err);
    await expect(requirePermission('flows.view')).rejects.toBe(err);
  });
});

describe('getEffectivePermissions', () => {
  it('one query total for an agent (not one per key)', async () => {
    mocks.loadOverridesForUser.mockResolvedValue(new Map([['users.create', true]]));
    const result = await getEffectivePermissions(ctx('agent'));
    expect(mocks.loadOverridesForUser).toHaveBeenCalledTimes(1);
    expect(result['users.create']).toBe(true);
    expect(result['users.view']).toBe(false); // Herdar → default
    expect(result['flows.view']).toBe(true); // Herdar → default
  });

  it('never calls the override store for owner/admin/viewer', async () => {
    await getEffectivePermissions(ctx('owner'));
    await getEffectivePermissions(ctx('admin'));
    await getEffectivePermissions(ctx('viewer'));
    expect(mocks.loadOverridesForUser).not.toHaveBeenCalled();
  });

  it('isolates two accounts — an override in account A never leaks into account B\'s effective set', async () => {
    mocks.loadOverridesForUser.mockImplementation(async (accountId: string) =>
      accountId === 'acct-a' ? new Map([['users.view', true]]) : new Map(),
    );
    const a = await getEffectivePermissions(ctx('agent', { accountId: 'acct-a', userId: 'user-a' }));
    const b = await getEffectivePermissions(ctx('agent', { accountId: 'acct-b', userId: 'user-a' }));
    expect(a['users.view']).toBe(true);
    expect(b['users.view']).toBe(false);
  });
});
