// ============================================================
// Safe internal-redirect helper for auth flows (currently just the
// password-recovery callback's `?next=` param).
//
// Why an allow-list instead of a "looks internal" heuristic
// ------------------------------------------------------------
// Parsing tricks (protocol-relative `//evil.example`, backslash
// variants, encoded schemes, `javascript:`, etc.) are an endless
// arms race. This app only ever needs to send visitors to a small,
// known set of destinations from this param, so we skip parsing
// entirely: `next` must be an EXACT match against a caller-supplied
// allow-list, or we fall back to a safe default. Every open-redirect
// trick above simply fails the equality check.
// ============================================================

/**
 * Resolve `next` to itself if — and only if — it exactly matches one
 * of `allowedPaths`; otherwise returns `fallback`.
 */
export function resolveSafeNextPath(
  next: string | null | undefined,
  allowedPaths: readonly string[],
  fallback: string,
): string {
  if (next && allowedPaths.includes(next)) return next;
  return fallback;
}
