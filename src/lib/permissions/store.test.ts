import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  deleteFn: vi.fn(),
  upsertFn: vi.fn(),
  from: vi.fn(),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.from }),
}));

import { loadOverride, loadOverridesForUser, resetOverrides, setOverrides } from './store';

beforeEach(() => {
  mocks.select.mockReset();
  mocks.deleteFn.mockReset();
  mocks.upsertFn.mockReset();
  mocks.from.mockReset();
});

describe('loadOverridesForUser', () => {
  it('returns a Map keyed by permission_key from the matched rows', async () => {
    mocks.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: async () => ({
            data: [
              { permission_key: 'users.view', allowed: true },
              { permission_key: 'queues.manage', allowed: false },
            ],
            error: null,
          }),
        }),
      }),
    });

    const result = await loadOverridesForUser('acct-1', 'user-1');
    expect(result.get('users.view')).toBe(true);
    expect(result.get('queues.manage')).toBe(false);
    expect(result.has('flows.view')).toBe(false); // Herdar — no row
  });

  it('fails closed to an empty Map (Herdar for everything) on a read error', async () => {
    mocks.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: null, error: { code: '500', message: 'boom' } }),
        }),
      }),
    });

    const result = await loadOverridesForUser('acct-1', 'user-1');
    expect(result.size).toBe(0);
  });
});

describe('loadOverride', () => {
  it('returns undefined (Herdar) when no row matches the single key', async () => {
    mocks.from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    });
    expect(await loadOverride('acct-1', 'user-1', 'users.view')).toBeUndefined();
  });
});

describe('setOverrides', () => {
  it('upserts Permitir/Bloquear values and deletes Herdar (null) keys, scoped to (account, user)', async () => {
    const deleteChain = {
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    deleteChain.eq.mockReturnValue(deleteChain);
    mocks.deleteFn.mockReturnValue(deleteChain);
    mocks.upsertFn.mockResolvedValue({ error: null });
    mocks.from.mockReturnValue({ delete: mocks.deleteFn, upsert: mocks.upsertFn });

    await setOverrides(
      'acct-1',
      'user-1',
      { 'users.create': true, 'queues.manage': false, 'flows.view': null },
      'superadmin-1',
    );

    expect(mocks.upsertFn).toHaveBeenCalledWith(
      [
        expect.objectContaining({ account_id: 'acct-1', user_id: 'user-1', permission_key: 'users.create', allowed: true, created_by_user_id: 'superadmin-1' }),
        expect.objectContaining({ account_id: 'acct-1', user_id: 'user-1', permission_key: 'queues.manage', allowed: false, created_by_user_id: 'superadmin-1' }),
      ],
      { onConflict: 'account_id,user_id,permission_key' },
    );
    expect(deleteChain.in).toHaveBeenCalledWith('permission_key', ['flows.view']);
  });
});

describe('resetOverrides', () => {
  it('deletes every row scoped to (account, user) — "Restaurar permissões padrão"', async () => {
    const chain = { eq: vi.fn(function (this: unknown) { return this; }) };
    chain.eq.mockImplementation(() => chain);
    // Last call in the chain must resolve — simulate `.eq().eq()` as a thenable.
    const finalChain = {
      eq: vi.fn().mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    };
    mocks.deleteFn.mockReturnValue(finalChain);
    mocks.from.mockReturnValue({ delete: mocks.deleteFn });

    await resetOverrides('acct-1', 'user-1');
    expect(mocks.from).toHaveBeenCalledWith('user_permission_overrides');
  });
});
