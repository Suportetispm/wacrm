// ============================================================
// GET /api/invitations/[token]/peek
//
// Public — no auth required. Lets the /join/<token> page render
// "You're being invited to <Account> as <Role>" before the
// visitor signs up or signs in.
//
// Security model
//   - Token is in the URL path, not the query, so it doesn't
//     show up in standard access-log "referer" fields the way a
//     `?token=` would.
//   - The plaintext token never crosses the DB boundary — we
//     hash it in TS first and look up by `token_hash`.
//   - The peek RPC is SECURITY DEFINER so it bypasses the RLS
//     that would otherwise block an anonymous SELECT on
//     `account_invitations`. It returns a fixed-shape JSON
//     payload that never leaks columns beyond what the join
//     page renders.
//   - Per-IP rate limit pinches brute-force enumeration of
//     tokens. With 256 bits of entropy the enumeration risk is
//     theoretical, but rate limiting is cheap insurance.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Best-effort client IP. The `x-forwarded-for` header is what
 * every reverse proxy (Vercel, Hostinger, Cloudflare) sets when
 * forwarding a request; we take the leftmost entry, which is
 * the original client.
 *
 * Falls back to a constant when no proxy is in front (e.g.
 * `localhost` during development) so rate-limit keys still
 * exist — the limit then effectively applies "globally," which
 * is fine for dev.
 *
 * Hardened against malformed headers: `x-forwarded-for` can legally
 * contain empty entries from a mangling proxy (e.g. a leading comma,
 * ",1.2.3.4") — naively taking `[0]` before trimming would return
 * `""`, which upstream turns into a shared rate-limit bucket key like
 * `peek:` for every client that triggers it. Every candidate is
 * trimmed and empty ones are skipped; only a genuinely non-empty
 * value is ever returned, else "unknown".
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  // Rate-limit by IP first. Returns 429 to a serial bruteforcer
  // before we ever touch the DB.
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`peek:${ip}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { ok: false, reason: "not_found" },
      { status: 404 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("peek_invitation", {
    p_token_hash: hashInviteToken(token),
  });

  if (error) {
    console.error("[peek] rpc error:", error);
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    );
  }

  // The RPC always returns a json object — either ok:true with
  // metadata or ok:false with a reason. Forward verbatim.
  return NextResponse.json(data);
}
