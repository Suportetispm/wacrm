// ============================================================
// Pure, framework-free helpers for the Internal Tickets Selects
// (src/app/(dashboard)/internal-tickets/page.tsx and [id]/page.tsx).
// ============================================================

export interface CatalogEntry {
  id: string
  name: string
}

/**
 * `{value, label}` pairs for a catalog Select's `items` prop — type,
 * status, stage, team, or company, all shaped `{id, name}`. `value`
 * stays the catalog row's UUID, `label` is its `name`.
 *
 * base-ui's closed-trigger `<Select.Value>` resolves its displayed
 * label ONLY from `Select.Root`'s `items` — never from the rendered
 * `<SelectItem>` children (see
 * node_modules/@base-ui/react/internals/resolveValueLabel.js), so
 * without this a picked catalog row renders as a raw UUID once
 * selected. Deliberately generic (not five near-duplicate
 * `buildTypeSelectItems`/`buildStatusSelectItems`/... functions) since
 * all five catalogs share the exact same `{id, name}` shape — a
 * queue-specific helper already exists for Flows/Settings/Tickets
 * (`buildQueueSelectItems` in
 * src/components/flows/forms/node-config-form.tsx) but reusing that
 * name here would be misleading for non-queue catalogs, so this is a
 * distinct, correctly-named helper for the same generic transform.
 */
export function buildCatalogSelectItems(
  items: CatalogEntry[],
): { value: string; label: string }[] {
  return items.map((x) => ({ value: x.id, label: x.name }))
}
