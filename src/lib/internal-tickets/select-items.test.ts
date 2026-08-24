import { describe, expect, it } from 'vitest'
import { resolveSelectedLabel } from '@base-ui/react/internals/resolveValueLabel'

import { buildCatalogSelectItems } from './select-items'

// Regression coverage for the Internal Tickets Selects (type, status,
// stage, team, company) showing raw UUIDs instead of friendly names.
// Root cause, same as every other Select in this audit: base-ui's
// <Select.Value> (the CLOSED trigger's displayed text) resolves a
// selected item's label from `Select.Root`'s `items` — never from the
// rendered <SelectItem> children.

const STATUSES = [
  { id: 'a4110000-0000-0000-0000-000000000001', name: 'Aberto' },
  { id: '05ef0000-0000-0000-0000-000000000002', name: 'Em andamento' },
]

describe('buildCatalogSelectItems', () => {
  it('maps id to `value` and name to `label` — never swapped', () => {
    expect(buildCatalogSelectItems(STATUSES)).toEqual([
      { value: 'a4110000-0000-0000-0000-000000000001', label: 'Aberto' },
      { value: '05ef0000-0000-0000-0000-000000000002', label: 'Em andamento' },
    ])
  })

  it('every item label is the catalog name, never its own id (no UUID as label)', () => {
    for (const item of buildCatalogSelectItems(STATUSES)) {
      expect(item.label).not.toBe(item.value)
      expect(item.label).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
    }
  })

  it('returns an empty list for an empty catalog', () => {
    expect(buildCatalogSelectItems([])).toEqual([])
  })
})

describe('resolveSelectedLabel (real @base-ui/react resolver) against catalog items', () => {
  it('a status UUID resolves to status.name, not the raw UUID', () => {
    const items = [{ value: 'all', label: 'Todos' }, ...buildCatalogSelectItems(STATUSES)]
    expect(resolveSelectedLabel('05ef0000-0000-0000-0000-000000000002', items)).toBe(
      'Em andamento',
    )
  })

  it('"all" resolves to the translated "Todos"/"Todas", not the literal string "all"', () => {
    expect(resolveSelectedLabel('all', [{ value: 'all', label: 'Todos' }, ...buildCatalogSelectItems(STATUSES)])).toBe(
      'Todos',
    )
  })

  it('a "none" sentinel (e.g. __none__ for stage/team/company) resolves to its own translated label, not the raw sentinel string', () => {
    const items = [{ value: '__none__', label: 'Nenhum' }, ...buildCatalogSelectItems(STATUSES)]
    expect(resolveSelectedLabel('__none__', items)).toBe('Nenhum')
  })

  it('DOCUMENTED, NOT FIXED (per this step\'s scope): an orphan catalog id with no matching item still falls back to the raw value itself', () => {
    const items = [{ value: 'all', label: 'Todos' }, ...buildCatalogSelectItems(STATUSES)]
    const orphanUuid = 'ffffffff-0000-0000-0000-000000000000'
    expect(resolveSelectedLabel(orphanUuid, items)).toBe(orphanUuid)
  })
})
