import { describe, expect, it } from 'vitest';
import {
  AGENT_PERMISSION_DEFAULTS,
  isPermissionKey,
  legacyHasPermission,
  PERMISSION_KEYS,
  type PermissionKey,
} from './permissions';

describe('PERMISSION_KEYS', () => {
  it('has exactly the 12 keys of FASE 1 — no users.remove, no users.disable, no superadmin.access', () => {
    expect([...PERMISSION_KEYS].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(PERMISSION_KEYS).not.toContain('users.remove');
    expect(PERMISSION_KEYS).not.toContain('users.disable');
    expect(PERMISSION_KEYS).not.toContain('superadmin.access');
  });

  it('AGENT_PERMISSION_DEFAULTS covers every key exactly once', () => {
    expect(Object.keys(AGENT_PERMISSION_DEFAULTS).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});

describe('AGENT_PERMISSION_DEFAULTS', () => {
  it('users.* and queues.* default to false (the FASE 1 restriction)', () => {
    expect(AGENT_PERMISSION_DEFAULTS['users.view']).toBe(false);
    expect(AGENT_PERMISSION_DEFAULTS['users.create']).toBe(false);
    expect(AGENT_PERMISSION_DEFAULTS['users.edit']).toBe(false);
    expect(AGENT_PERMISSION_DEFAULTS['queues.view']).toBe(false);
    expect(AGENT_PERMISSION_DEFAULTS['queues.manage']).toBe(false);
  });

  it('flows/automations/quick_replies default to true (unchanged agent capability)', () => {
    expect(AGENT_PERMISSION_DEFAULTS['flows.view']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['flows.manage']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['flows.activate']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['automations.view']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['automations.manage']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['quick_replies.view']).toBe(true);
    expect(AGENT_PERMISSION_DEFAULTS['quick_replies.manage']).toBe(true);
  });
});

describe('legacyHasPermission — owner/admin/viewer must never regress', () => {
  const VIEW_KEYS: PermissionKey[] = [
    'users.view',
    'queues.view',
    'flows.view',
    'automations.view',
    'quick_replies.view',
  ];

  it('every .view key is unrestricted for every non-agent role (no route had a role gate pre-FASE-1)', () => {
    for (const key of VIEW_KEYS) {
      expect(legacyHasPermission('owner', key)).toBe(true);
      expect(legacyHasPermission('admin', key)).toBe(true);
      expect(legacyHasPermission('viewer', key)).toBe(true);
    }
  });

  it('users.create / users.edit / queues.manage require admin+', () => {
    for (const key of ['users.create', 'users.edit', 'queues.manage'] as const) {
      expect(legacyHasPermission('owner', key)).toBe(true);
      expect(legacyHasPermission('admin', key)).toBe(true);
      expect(legacyHasPermission('viewer', key)).toBe(false);
    }
  });

  it('flows.manage / flows.activate / automations.manage / quick_replies.manage require agent+', () => {
    for (const key of [
      'flows.manage',
      'flows.activate',
      'automations.manage',
      'quick_replies.manage',
    ] as const) {
      expect(legacyHasPermission('owner', key)).toBe(true);
      expect(legacyHasPermission('admin', key)).toBe(true);
      expect(legacyHasPermission('viewer', key)).toBe(false);
    }
  });
});

describe('isPermissionKey', () => {
  it('accepts every catalog key and rejects unknown strings', () => {
    for (const key of PERMISSION_KEYS) {
      expect(isPermissionKey(key)).toBe(true);
    }
    expect(isPermissionKey('users.disable')).toBe(false);
    expect(isPermissionKey('superadmin.access')).toBe(false);
    expect(isPermissionKey('not-a-key')).toBe(false);
    expect(isPermissionKey(123)).toBe(false);
    expect(isPermissionKey(null)).toBe(false);
  });
});
