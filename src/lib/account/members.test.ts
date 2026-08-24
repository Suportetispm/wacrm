import { describe, expect, it } from 'vitest'
import { resolveSelectedLabel } from '@base-ui/react/internals/resolveValueLabel'

import { buildAccountRoleSelectItems, buildMemberSelectItems, memberLabel } from './members'

// Regression coverage for the "Select shows a raw UUID/enum instead of
// a friendly label" bug class (Etapa 2 — setores e membros). Root
// cause: base-ui's <Select.Value> (the CLOSED trigger's displayed
// text) resolves a selected item's label from the `items` list passed
// to <Select.Root> — never from the rendered <SelectItem> children —
// so any Select missing `items` falls back to showing the raw
// value once a selection is made.

describe('memberLabel', () => {
  it('prefers full_name', () => {
    expect(memberLabel({ user_id: 'u1', full_name: 'Jane Doe', email: 'jane@acme.com' })).toBe(
      'Jane Doe',
    )
  })

  it('falls back to email when full_name is null', () => {
    expect(memberLabel({ user_id: 'u1', full_name: null, email: 'jane@acme.com' })).toBe(
      'jane@acme.com',
    )
  })

  it('falls back to the raw user_id when both are null', () => {
    expect(memberLabel({ user_id: 'u1', full_name: null, email: null })).toBe('u1')
  })
})

describe('buildMemberSelectItems', () => {
  const MEMBERS = [
    { user_id: '83ff3bfc-d750-49cf-0000-000000000001', full_name: 'Fernandes de Macedo', email: 'fm@acme.com' },
    { user_id: '5a11c2e4-9b1a-4a3e-0000-000000000002', full_name: null, email: 'no-name@acme.com' },
  ]

  it('maps user_id to `value` and memberLabel(m) to `label` — never swapped', () => {
    expect(buildMemberSelectItems(MEMBERS)).toEqual([
      { value: '83ff3bfc-d750-49cf-0000-000000000001', label: 'Fernandes de Macedo' },
      { value: '5a11c2e4-9b1a-4a3e-0000-000000000002', label: 'no-name@acme.com' },
    ])
  })

  it('every item label is the member name/email, never its own user_id (no UUID as label)', () => {
    for (const item of buildMemberSelectItems(MEMBERS)) {
      expect(item.label).not.toBe(item.value)
      expect(item.label).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
    }
  })

  it('returns an empty list for an empty member list', () => {
    expect(buildMemberSelectItems([])).toEqual([])
  })
})

describe('buildAccountRoleSelectItems', () => {
  it('maps admin/agent/viewer to whatever label the caller\'s t() already returns — value stays the technical enum', () => {
    const t = (key: 'admin' | 'agent' | 'viewer') =>
      ({ admin: 'Administrador', agent: 'Atendente', viewer: 'Visualizador' })[key]
    expect(buildAccountRoleSelectItems(t)).toEqual([
      { value: 'admin', label: 'Administrador' },
      { value: 'agent', label: 'Atendente' },
      { value: 'viewer', label: 'Visualizador' },
    ])
  })

  it('no known role enum leaks through as its own label', () => {
    const t = (key: 'admin' | 'agent' | 'viewer') =>
      ({ admin: 'Administrador', agent: 'Atendente', viewer: 'Visualizador' })[key]
    for (const item of buildAccountRoleSelectItems(t)) {
      expect(item.label).not.toBe(item.value)
    }
  })
})

describe('resolveSelectedLabel (real @base-ui/react resolver) against our items', () => {
  // Exercises the actual library function the Select trigger calls
  // (node_modules/@base-ui/react/internals/resolveValueLabel.js), not
  // just our own item-builder output.

  it('a queue/member UUID resolves to its name, not the raw UUID', () => {
    const items = buildMemberSelectItems([
      { user_id: '83ff3bfc-d750-49cf-0000-000000000001', full_name: 'Fernandes de Macedo', email: null },
    ])
    expect(resolveSelectedLabel('83ff3bfc-d750-49cf-0000-000000000001', items)).toBe(
      'Fernandes de Macedo',
    )
  })

  it('a role enum resolves to its translated label, not the raw "admin"/"agent"/"viewer" string', () => {
    const t = (key: 'admin' | 'agent' | 'viewer') =>
      ({ admin: 'Administrador', agent: 'Atendente', viewer: 'Visualizador' })[key]
    const items = buildAccountRoleSelectItems(t)
    expect(resolveSelectedLabel('admin', items)).toBe('Administrador')
    expect(resolveSelectedLabel('agent', items)).toBe('Atendente')
    expect(resolveSelectedLabel('viewer', items)).toBe('Visualizador')
  })

  it('DOCUMENTED, NOT FIXED (per this step\'s scope): an orphan value with no matching item still falls back to the raw value itself', () => {
    const items = buildMemberSelectItems([
      { user_id: 'known-1', full_name: 'Known User', email: null },
    ])
    const orphanUuid = 'ffffffff-0000-0000-0000-000000000000'
    expect(resolveSelectedLabel(orphanUuid, items)).toBe(orphanUuid)
  })
})
