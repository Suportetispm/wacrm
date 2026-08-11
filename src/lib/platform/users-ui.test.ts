import { describe, expect, it } from 'vitest'

import {
  ROLE_LABEL_KEYS,
  buildCreateUserPayload,
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
