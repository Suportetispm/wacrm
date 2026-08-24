import { describe, expect, it } from 'vitest'
import { resolveSelectedLabel } from '@base-ui/react/internals/resolveValueLabel'

import {
  ROLE_LABEL_KEYS,
  buildAccountSelectItems,
  buildCreateUserPayload,
  buildRoleSelectItems,
  buildStatusFilterSelectItems,
  buildUpdateUserPayload,
  buildUsersQueryParams,
  classifyUserApiError,
  emptyUserFormState,
  isUserFormValid,
  queueSelectionOnAccountChange,
} from './users-ui'

describe('ROLE_LABEL_KEYS', () => {
  it('maps admin/agent labels — the only two roles this surface manages', () => {
    expect(ROLE_LABEL_KEYS).toEqual({ admin: 'roleAdmin', agent: 'roleAgent' })
  })
})

describe('buildUsersQueryParams', () => {
  it('omits every filter left at its default ("all"/empty)', () => {
    const params = buildUsersQueryParams({ q: '', accountId: '', role: 'all', isActive: 'all' })
    expect(params.toString()).toBe('')
  })

  it('includes only the filters that are actually set, trimming q', () => {
    const params = buildUsersQueryParams({
      q: '  jane  ',
      accountId: 'acct-1',
      role: 'agent',
      isActive: 'true',
    })
    expect(params.get('q')).toBe('jane')
    expect(params.get('account_id')).toBe('acct-1')
    expect(params.get('role')).toBe('agent')
    expect(params.get('is_active')).toBe('true')
  })

  it('a whitespace-only search collapses to no q param', () => {
    const params = buildUsersQueryParams({ q: '   ', accountId: '', role: 'all', isActive: 'all' })
    expect(params.has('q')).toBe(false)
  })
})

describe('classifyUserApiError', () => {
  it('409 → translated errorEmailExists, never the raw server text', () => {
    const info = classifyUserApiError(409, { error: 'duplicate key value violates unique constraint' })
    expect(info).toEqual({ translatedKey: 'errorEmailExists', detail: null })
  })

  it('400 → shows the (already-sanitized) server message as-is', () => {
    const info = classifyUserApiError(400, { error: "'account_role' must be 'admin' or 'agent'" })
    expect(info).toEqual({ translatedKey: null, detail: "'account_role' must be 'admin' or 'agent'" })
  })

  it('400 with a non-string/missing error body falls back to null detail', () => {
    expect(classifyUserApiError(400, null)).toEqual({ translatedKey: null, detail: null })
    expect(classifyUserApiError(400, {})).toEqual({ translatedKey: null, detail: null })
  })

  it('403 → translated errorForbidden, body ignored', () => {
    const info = classifyUserApiError(403, { error: 'Forbidden' })
    expect(info).toEqual({ translatedKey: 'errorForbidden', detail: null })
  })

  it('500 (or anything else) → generic translated message, raw body never surfaced', () => {
    const info = classifyUserApiError(500, { error: 'relation "profiles" does not exist' })
    expect(info.translatedKey).toBe('errorGeneric')
    expect(info.detail).toBeNull()
  })
})

describe('emptyUserFormState', () => {
  it('starts with an empty password and the least-privileged role', () => {
    const form = emptyUserFormState()
    expect(form.password).toBe('')
    expect(form.role).toBe('agent')
    expect(form.queueIds).toEqual([])
    expect(form.isActive).toBe(true)
  })

  it('returns a fresh object each call — resetting after success never shares state with a previous open', () => {
    const a = emptyUserFormState()
    const b = emptyUserFormState()
    expect(a).not.toBe(b);
    (a.queueIds as string[]).push('q1')
    expect(b.queueIds).toEqual([])
  })
})

describe('queueSelectionOnAccountChange', () => {
  it('clears the selection when the company actually changes', () => {
    expect(queueSelectionOnAccountChange('acct-1', 'acct-2', ['q1', 'q2'])).toEqual([])
  })

  it('preserves the selection when the company id is unchanged', () => {
    expect(queueSelectionOnAccountChange('acct-1', 'acct-1', ['q1', 'q2'])).toEqual(['q1', 'q2'])
  })

  it('clears when moving from no company selected to a real one', () => {
    expect(queueSelectionOnAccountChange('', 'acct-1', ['q1'])).toEqual([])
  })
})

describe('isUserFormValid', () => {
  it('create mode requires name, email, a long-enough password and a company', () => {
    const base = emptyUserFormState()
    expect(isUserFormValid('create', base)).toBe(false)
    expect(
      isUserFormValid('create', { ...base, fullName: 'Jane', email: 'jane@acme.com', password: 'short', accountId: 'acct-1' }),
    ).toBe(false)
    expect(
      isUserFormValid('create', { ...base, fullName: 'Jane', email: 'jane@acme.com', password: 'long-enough-pw', accountId: 'acct-1' }),
    ).toBe(true)
  })

  it('edit mode only requires a non-empty name — email/password/company are not part of the edit form', () => {
    const base = emptyUserFormState()
    expect(isUserFormValid('edit', { ...base, fullName: '   ' })).toBe(false)
    expect(isUserFormValid('edit', { ...base, fullName: 'Jane Doe' })).toBe(true)
  })
})

describe('buildCreateUserPayload / buildUpdateUserPayload', () => {
  it('create payload trims name/email and includes the password (required to create the auth user)', () => {
    const form = { ...emptyUserFormState(), fullName: '  Jane Doe  ', email: ' jane@acme.com ', password: 'correct-horse', accountId: 'acct-1', role: 'admin' as const, queueIds: ['q1'] }
    expect(buildCreateUserPayload(form)).toEqual({
      full_name: 'Jane Doe',
      email: 'jane@acme.com',
      password: 'correct-horse',
      account_id: 'acct-1',
      account_role: 'admin',
      queue_ids: ['q1'],
    })
  })

  it('update payload never includes email, account_id or password — those are not editable in this version', () => {
    const form = { ...emptyUserFormState(), fullName: 'Jane Doe', email: 'jane@acme.com', password: 'irrelevant', accountId: 'acct-1', role: 'admin' as const, isActive: false, queueIds: ['q2'] }
    const payload = buildUpdateUserPayload(form)
    expect(payload).toEqual({
      full_name: 'Jane Doe',
      account_role: 'admin',
      is_active: false,
      queue_ids: ['q2'],
    })
    expect(payload).not.toHaveProperty('email')
    expect(payload).not.toHaveProperty('account_id')
    expect(payload).not.toHaveProperty('password')
  })
})

describe('buildAccountSelectItems', () => {
  it('maps each account UUID to its friendly name — value untouched, label is the name', () => {
    const items = buildAccountSelectItems([
      { id: '83ff3bfc-d750-49cf-0000-000000000001', name: 'Fernandes de Macedo' },
      { id: '5a11c2e4-9b1a-4a3e-0000-000000000002', name: 'Acme Ltda' },
    ])
    expect(items).toEqual([
      { value: '83ff3bfc-d750-49cf-0000-000000000001', label: 'Fernandes de Macedo' },
      { value: '5a11c2e4-9b1a-4a3e-0000-000000000002', label: 'Acme Ltda' },
    ])
  })

  it('an empty account list produces an empty items array (no "all" sentinel of its own)', () => {
    expect(buildAccountSelectItems([])).toEqual([])
  })
})

describe('buildRoleSelectItems', () => {
  it('maps admin/agent to whatever label the caller\'s t() already returns for this namespace — value stays the technical enum', () => {
    const t = (key: 'roleAdmin' | 'roleAgent') =>
      ({ roleAdmin: 'Administrador', roleAgent: 'Usuário' })[key] // Admin.users namespace wording, kept as-is (not unified with sidebar/flows)
    expect(buildRoleSelectItems(t)).toEqual([
      { value: 'admin', label: 'Administrador' },
      { value: 'agent', label: 'Usuário' },
    ])
  })
})

describe('buildStatusFilterSelectItems', () => {
  it('maps the isActive filter\'s technical values to friendly labels, "all" included', () => {
    const t = (key: 'filterStatusAll' | 'active' | 'inactive') =>
      ({ filterStatusAll: 'Todos', active: 'Ativo', inactive: 'Inativo' })[key]
    expect(buildStatusFilterSelectItems(t)).toEqual([
      { value: 'all', label: 'Todos' },
      { value: 'true', label: 'Ativo' },
      { value: 'false', label: 'Inativo' },
    ])
  })
})

describe('resolveSelectedLabel (real @base-ui/react resolver) against our items', () => {
  // These exercise the actual library function the Select trigger calls
  // (node_modules/@base-ui/react/internals/resolveValueLabel.js), not
  // just our own item-builder output — proving the closed trigger
  // really does resolve a friendly label end-to-end, and documenting
  // exactly what happens for a value that isn't in the list.

  const accountItems = [
    { value: 'all', label: 'Todos' },
    ...buildAccountSelectItems([
      { id: '83ff3bfc-d750-49cf-0000-000000000001', name: 'Fernandes de Macedo' },
    ]),
  ]

  it('an account UUID resolves to account.name, not the raw UUID', () => {
    expect(resolveSelectedLabel('83ff3bfc-d750-49cf-0000-000000000001', accountItems)).toBe(
      'Fernandes de Macedo',
    )
  })

  it('"all" resolves to the translated "Todos", not the literal string "all"', () => {
    expect(resolveSelectedLabel('all', accountItems)).toBe('Todos')
  })

  it('a role enum resolves to its translated label, not the raw "admin"/"agent" string', () => {
    const t = (key: 'roleAdmin' | 'roleAgent') =>
      ({ roleAdmin: 'Administrador', roleAgent: 'Atendente' })[key]
    const roleItems = [{ value: 'all', label: 'Todos' }, ...buildRoleSelectItems(t)]
    expect(resolveSelectedLabel('admin', roleItems)).toBe('Administrador')
    expect(resolveSelectedLabel('agent', roleItems)).toBe('Atendente')
  })

  it('DOCUMENTED, NOT FIXED: a value with no matching item (e.g. an account deleted after being selected) falls back to the raw value itself — @base-ui/react has no built-in "not found" label', () => {
    // This is the real library behavior (resolveValueLabel.js:69-107 →
    // stringifyAsLabel → serializeValue): no match in `items` means the
    // fallback re-serializes the raw value. For a plain string value
    // that means the exact same string comes back — i.e. an orphaned
    // UUID would still render as that UUID in the closed trigger.
    // Per this step's scope, no new fallback is implemented — this
    // test only pins the current, real behavior for the next step to
    // build on.
    const orphanUuid = 'ffffffff-0000-0000-0000-000000000000'
    expect(resolveSelectedLabel(orphanUuid, accountItems)).toBe(orphanUuid)
  })

  it('no known account UUID leaks through as a label anywhere in the built items', () => {
    for (const item of accountItems) {
      if (item.value === 'all') continue
      expect(item.label).not.toBe(item.value)
    }
  })

  it('no known role/status enum leaks through as a label anywhere in the built items', () => {
    const t = (key: 'roleAdmin' | 'roleAgent' | 'filterStatusAll' | 'active' | 'inactive') =>
      ({
        roleAdmin: 'Administrador',
        roleAgent: 'Atendente',
        filterStatusAll: 'Todos',
        active: 'Ativo',
        inactive: 'Inativo',
      })[key]
    const allItems = [...buildRoleSelectItems(t), ...buildStatusFilterSelectItems(t)]
    for (const item of allItems) {
      expect(item.label).not.toBe(item.value)
    }
  })
})
