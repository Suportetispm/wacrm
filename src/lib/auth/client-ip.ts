/**
 * Best-effort client IP, hardened against malformed proxy headers.
 * Checks x-forwarded-for first, then x-real-ip, and never returns
 * an empty value.
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const firstNonEmpty = xff
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.length > 0);

    if (firstNonEmpty) return firstNonEmpty;
  }

  const xri = request.headers.get("x-real-ip");
  if (xri) {
    const trimmed = xri.trim();
    if (trimmed) return trimmed;
  }

  return "unknown";
}
