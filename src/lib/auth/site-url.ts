// ============================================================
// Trusted origin resolver for browser-issued auth redirect links
// (currently just resetPasswordForEmail's `redirectTo`).
//
// Resolution order:
//   1. `NEXT_PUBLIC_SITE_URL` — operator's explicit config, always
//      wins when set, so links point at the canonical domain even
//      behind a proxy that rewrites what the browser sees.
//   2. The page's own `window.location.origin` — safe here (unlike
//      a server trusting a request's Host/Origin header) because it
//      reflects the actual address bar of the page running this
//      code, not something an attacker can set from outside.
//
// Never hardcodes localhost or any other default — a missing env
// var just falls through to the real browser origin.
// ============================================================

export function resolveTrustedOrigin(
  windowOrigin: string,
  envSiteUrl: string | undefined,
): string {
  const explicit = envSiteUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return windowOrigin.replace(/\/+$/, '');
}
