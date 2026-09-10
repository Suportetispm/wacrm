// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, CGNAT, or otherwise non-publicly-
// routable — including a hostname that only *resolves* to one of those
// (every address from `dns.lookup(..., { all: true })` is checked, not
// just the first), and a literal IP written in a non-standard form
// (decimal/hex/octal IPv4, or an IPv4-mapped IPv6 host in either its
// dotted or hex-group form) — the WHATWG URL parser itself canonicalizes
// all of those into the same literal-IP branch before we ever see them.
//
// Called from two places: at webhook registration/edit time (POST/PATCH
// `/api/v1/webhooks`), so a bad URL 400s immediately instead of sitting
// around as a disabled endpoint; and again at delivery time
// (`deliver.ts`), since DNS answers can change between the two. Combined
// with `redirect: 'manual'` at the delivery call site (so a public URL
// can't 3xx-bounce to an internal one), this blocks the common SSRF
// vectors.
//
// RESIDUAL RISK — DNS rebinding: this function re-resolves DNS on every
// call, which closes the *registration-time* TOCTOU window (an attacker
// can't register a public-looking hostname and flip its DNS record
// before the check runs, because the check runs again on every
// delivery). It does NOT close the *delivery-time* window: between this
// check returning true and `fetch()` itself resolving + connecting a
// few milliseconds later, a hostname with a very low/zero DNS TTL could
// answer differently and land on a private address. Eliminating that
// fully requires pinning the exact IP this function validated into the
// actual socket (e.g. a custom undici `Agent`/`lookup` dispatcher), which
// this module does not attempt — the current architecture only
// re-validates before each attempt, it doesn't pin the connection. Given
// the short (5s) delivery timeout and single-attempt semantics, the
// exploitable window is narrow but not zero.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 ULA

  // IPv4-mapped (::ffff:a.b.c.d). This is the form DNS resolvers
  // typically hand back via inet_ntop.
  const mappedDotted = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isPrivateOrReservedIp(mappedDotted[1]);

  // IPv4-mapped, hex-group form (::ffff:7f00:1). This is what the
  // WHATWG URL parser normalizes a *literal* bracketed IPv6 host to —
  // `new URL('https://[::ffff:127.0.0.1]/x').hostname` is
  // `[::ffff:7f00:1]`, never the dotted form. Without this branch,
  // that literal URL would sail through as "not private".
  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateOrReservedIp(
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    );
  }

  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, an obvious internal
 * name (`localhost`, `*.local`, `*.internal`), a literal private IP, or
 * a hostname that resolves to any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}
