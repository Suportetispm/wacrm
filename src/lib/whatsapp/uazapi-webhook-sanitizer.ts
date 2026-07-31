/**
 * TEMPORARY — UAZAPI webhook payload capture.
 *
 * Produces a structural-only summary of an arbitrary JSON value: key
 * names, JS types, sizes/counts, and nesting depth — never the actual
 * values (phones, names, text, ids, URLs, base64, tokens). Used to
 * safely learn UAZAPI's real webhook payload shape before writing any
 * persistence logic. Remove this file once the real contract is
 * confirmed and this capture route is replaced.
 */

const MAX_DEPTH = 6
const MAX_KEYS_PER_OBJECT = 50
const MAX_ITEMS_TO_DESCRIBE = 5 // sample this many array items/object keys per level
const MAX_TOTAL_NODES = 500 // global budget across the whole tree — guards huge payloads

export interface SanitizedNode {
  key: string
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  depth: number
  /** Strings only: character length. Never the string itself. */
  approxSize?: number
  /** Arrays only: TRUE total item count, even if not all are described below. */
  itemCount?: number
  /** Objects only: TRUE total key count, even if not all are described below. */
  keyCount?: number
  children?: SanitizedNode[]
  /** True when a limit (depth, key/item count, or node budget) cut this branch short. */
  truncated?: boolean
}

export function sanitizeWebhookPayload(value: unknown): SanitizedNode {
  const budget = { remaining: MAX_TOTAL_NODES }
  return describe('root', value, 0, budget)
}

function describe(
  key: string,
  value: unknown,
  depth: number,
  budget: { remaining: number },
): SanitizedNode {
  budget.remaining -= 1

  if (value === null) return { key, type: 'null', depth }
  if (value === undefined) return { key, type: 'undefined', depth }

  const t = typeof value
  if (t === 'string') return { key, type: 'string', depth, approxSize: (value as string).length }
  if (t === 'number') return { key, type: 'number', depth }
  if (t === 'boolean') return { key, type: 'boolean', depth }

  if (Array.isArray(value)) {
    const node: SanitizedNode = { key, type: 'array', depth, itemCount: value.length }
    if (depth >= MAX_DEPTH || budget.remaining <= 0) return { ...node, truncated: true }

    const sampleCount = Math.min(value.length, MAX_ITEMS_TO_DESCRIBE)
    node.children = []
    for (let i = 0; i < sampleCount; i++) {
      if (budget.remaining <= 0) {
        node.truncated = true
        break
      }
      node.children.push(describe(`[${i}]`, value[i], depth + 1, budget))
    }
    if (value.length > sampleCount) node.truncated = true
    return node
  }

  if (t === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const node: SanitizedNode = { key, type: 'object', depth, keyCount: keys.length }
    if (depth >= MAX_DEPTH || budget.remaining <= 0) return { ...node, truncated: true }

    const sampleKeys = keys.slice(0, Math.min(keys.length, MAX_KEYS_PER_OBJECT, MAX_ITEMS_TO_DESCRIBE))
    node.children = []
    for (const k of sampleKeys) {
      if (budget.remaining <= 0) {
        node.truncated = true
        break
      }
      node.children.push(describe(k, (value as Record<string, unknown>)[k], depth + 1, budget))
    }
    if (keys.length > sampleKeys.length) node.truncated = true
    return node
  }

  // function/symbol/bigint shouldn't appear in parsed JSON, but handle
  // defensively rather than throw.
  return { key, type: 'undefined', depth, truncated: true }
}
