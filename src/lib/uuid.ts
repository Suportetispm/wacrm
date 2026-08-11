// ============================================================
// Lightweight UUID format check — no new dependency. Deliberately
// permissive on version/variant bits (matches what Postgres's own
// `uuid` input function actually accepts: any 8-4-4-4-12 hex-digit
// shape, not strictly-v4-only) — this is a FORMAT check only, never
// existence or tenancy. Those stay the job of the RPC/RLS layer that
// already validates them; this just turns an obviously malformed id
// into a clean 400 before it ever reaches Postgres as a cast error.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
