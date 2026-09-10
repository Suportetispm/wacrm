/**
 * Shared, cross-instance rate limiter.
 *
 * Primary store: a Postgres table (`rate_limit_buckets`) written
 * through the atomic `rate_limit_check()` RPC (see
 * supabase/migrations/066_rate_limit_shared_store.sql — NOT applied
 * yet, see that file's header). Every instance/replica/serverless
 * invocation hits the same row for a given key, so the limit is
 * actually enforced account/user/key-wide instead of per-process.
 *
 * FAILOVER — deliberate design decision, not an oversight: if the
 * Postgres call itself fails (network blip, DB restart, missing
 * service-role env in a misconfigured deploy), `checkRateLimit` does
 * NOT fail open (unlimited) NOR fail fully closed (reject every
 * request app-wide). It falls back to the exact in-memory fixed-window
 * counter this module used before this change. Rationale:
 *   - None of the buckets below gate authentication or a security
 *     boundary — the real authorization checks (requireRole,
 *     is_account_member, RLS, API-key scopes) are enforced
 *     independently and are NOT part of this module. These buckets
 *     only bound abuse/cost (spam sends, LLM spend, admin-action
 *     scripting, public-API hammering).
 *   - Fully failing closed here would turn a transient Postgres hiccup
 *     into a site-wide outage for something that is, by design, a
 *     secondary defense — worse than the problem it's meant to solve.
 *   - Fully failing open (always allow) would silently disable every
 *     budget in this file for the duration of the incident with zero
 *     trace besides a log line.
 *   - Falling back to the pre-existing per-instance in-memory limiter
 *     keeps *some* real bound in place (as good as this project's
 *     behavior before this migration) while the shared store is down,
 *     and every failure is logged so an operator can see it happened.
 * Residual risk: during a shared-store outage, the effective limit
 * reverts to "per-instance" — a caller hitting N different instances
 * can get roughly N× the intended budget until the store recovers.
 * That's the same ceiling this project already lived with in
 * production before today; it is not a new exposure.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

// ------------------------------------------------------------
// Primary store — Postgres RPC (rate_limit_check), service-role.
//
// Lazy, shared client — mirrors the identical pattern in
// src/lib/flows/admin-client.ts, src/lib/automations/admin-client.ts,
// etc. Not exported: nothing outside this module needs it, and every
// other domain that needs a service-role client keeps its own copy by
// this project's convention rather than sharing one generic export.
// ------------------------------------------------------------
let _adminClient: SupabaseClient | null = null;

function rateLimitAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

interface RpcRow {
  allowed: boolean;
  count: number;
  reset_at: string;
}

async function checkRateLimitShared(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): Promise<RateLimitResult> {
  const { data, error } = await rateLimitAdminClient().rpc('rate_limit_check', {
    p_key: key,
    p_limit: limit,
    p_window_ms: windowMs,
  });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null;
  if (!row) throw new Error('rate_limit_check returned no row');

  return {
    success: Boolean(row.allowed),
    remaining: Math.max(0, limit - Number(row.count)),
    reset: new Date(row.reset_at).getTime(),
    limit,
  };
}

// ------------------------------------------------------------
// Fallback store — in-memory per-process fixed-window counter. This
// is the module's entire pre-migration implementation, kept verbatim
// as the degraded path used only when checkRateLimitShared() throws.
// ------------------------------------------------------------
interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function checkRateLimitInMemory(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

/**
 * Check + consume one request against `key`'s budget. Always tries
 * the shared Postgres store first; falls back to the per-process
 * in-memory counter only if that call throws (see file header for
 * why this isn't fail-open or fail-closed).
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  try {
    return await checkRateLimitShared(key, options);
  } catch (err) {
    console.error(
      `[rate-limit] shared store unavailable for key "${key}" — falling back to per-instance limiting:`,
      err,
    );
    return checkRateLimitInMemory(key, options);
  }
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. 5/min per user — even a 1 000-recipient
   *  broadcast is one call; this caps the rate at which a single user
   *  can launch campaigns, not the messages inside one. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Platform-scope actions (Superadmin): create/rename/enable/
   *  disable an account. Same budget as adminAction, kept as its own
   *  bucket so a busy tenant admin never shares a limit with a
   *  platform admin — they're unrelated actors by design. */
  platformAdminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Enforced against the shared store, so this budget now
   *  holds regardless of how many instances/replicas serve the
   *  request (see file header). */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
  /** Ticket operational actions (claim/transfer-queue/transfer-agent/
   *  waiting-customer/resume/close), per user, shared across all six
   *  — see supabase/migrations/049_ticket_operations.sql. 30/min is
   *  generous for a human working a busy shift (one action every 2s
   *  sustained) while bounding a runaway script or a misbehaving UI
   *  retry loop. GET /api/tickets is read-only and not rate-limited. */
  ticketAction: { limit: 30, windowMs: 60_000 },
  /** AI auto-reply generation, per account. The per-conversation cap
   *  (`auto_reply_max_per_conversation`) bounds one thread; this bounds
   *  the whole account across threads, so a burst of inbound from many
   *  customers at once can't run the BYO key past the provider's limit
   *  or the owner's budget. 30/min is generous for organic inbound while
   *  capping a stampede; excess inbounds simply don't get an auto-reply
   *  (they still land in the inbox for a human). */
  aiAutoReplyAccount: { limit: 30, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory fallback state so unit
 *  tests don't leak buckets across files. Not wired up in production
 *  code. Does not touch the shared Postgres store — tests never reach
 *  it (no Supabase env configured under vitest), so every test run
 *  exercises the in-memory fallback path by construction. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
