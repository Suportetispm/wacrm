import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real createClient by default so any test that doesn't
// override it gets production behavior: with no
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY configured
// (true under vitest — see vitest.config.ts), the real createClient
// throws synchronously on the missing URL, which is exactly what
// drives checkRateLimit's fallback path in production during a real
// outage. Individual tests override the return value to exercise the
// "shared store available" path instead.
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

import { createClient } from "@supabase/supabase-js";
import {
  __resetRateLimitForTests,
  checkRateLimit,
  rateLimitResponse,
} from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit (falls back to in-memory — no Supabase env under vitest)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("permits the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user:1", OPTS);
    expect(result).toMatchObject({
      success: true,
      remaining: 2,
      limit: 3,
    });
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("permits exactly `limit` requests then rejects the next", async () => {
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    const over = await checkRateLimit("user:1", OPTS);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate counters per key", async () => {
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    // user:1 is at the cap, user:2 should still be unaffected.
    const other = await checkRateLimit("user:2", OPTS);
    expect(other.success).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("opens a fresh window after `windowMs` elapses", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      __resetRateLimitForTests();

      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      expect((await checkRateLimit("user:1", OPTS)).success).toBe(false);

      // Jump just past the window.
      vi.setSystemTime(t0 + OPTS.windowMs + 1);
      const refreshed = await checkRateLimit("user:1", OPTS);
      expect(refreshed.success).toBe(true);
      expect(refreshed.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never rejects even when the shared store is unreachable", async () => {
    // This is the actual behavior under test throughout this describe
    // block (no Supabase env configured) — asserted explicitly once so
    // the "falls back silently, never throws" contract has its own
    // test instead of being an implicit side effect of every other case.
    await expect(checkRateLimit("user:1", OPTS)).resolves.toMatchObject({
      success: true,
    });
  });
});

describe("checkRateLimit (shared Postgres store available)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("uses the RPC result when the call succeeds", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, count: 7, reset_at: "2026-05-01T00:01:00.000Z" }],
      error: null,
    });
    vi.mocked(createClient).mockReturnValueOnce({ rpc } as never);

    // Fresh module instance: rate-limit.ts caches its admin client in a
    // module-level singleton, so a prior test's cached client (or lack
    // thereof) must not leak into this one.
    vi.resetModules();
    const { checkRateLimit: freshCheckRateLimit } = await import("./rate-limit");

    const result = await freshCheckRateLimit("account:acct-1", { limit: 10, windowMs: 60_000 });
    expect(rpc).toHaveBeenCalledWith("rate_limit_check", {
      p_key: "account:acct-1",
      p_limit: 10,
      p_window_ms: 60_000,
    });
    expect(result).toEqual({
      success: true,
      remaining: 3,
      reset: new Date("2026-05-01T00:01:00.000Z").getTime(),
      limit: 10,
    });
  });

  it("denies once the RPC reports the window is exhausted", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, count: 11, reset_at: "2026-05-01T00:01:00.000Z" }],
      error: null,
    });
    vi.mocked(createClient).mockReturnValueOnce({ rpc } as never);

    vi.resetModules();
    const { checkRateLimit: freshCheckRateLimit } = await import("./rate-limit");

    const result = await freshCheckRateLimit("account:acct-1", { limit: 10, windowMs: 60_000 });
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0); // clamped, never negative
  });

  it("falls back to in-memory counting when the RPC errors, and logs it", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("connection refused") });
    vi.mocked(createClient).mockReturnValueOnce({ rpc } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.resetModules();
    const { checkRateLimit: freshCheckRateLimit } = await import("./rate-limit");

    const result = await freshCheckRateLimit("account:acct-2", { limit: 5, windowMs: 60_000 });
    expect(result).toMatchObject({ success: true, remaining: 4, limit: 5 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("shared store unavailable"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("falls back to in-memory counting when the RPC call itself rejects (real network exception)", async () => {
    // Distinct from the case above: here `.rpc()` never resolves at
    // all — it rejects, the way a genuine network failure (timeout,
    // DNS, connection reset) surfaces, as opposed to a resolved
    // response carrying an `error` field. `checkRateLimit`'s
    // try/catch must catch this the same way.
    const rpc = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    vi.mocked(createClient).mockReturnValueOnce({ rpc } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.resetModules();
    const { checkRateLimit: freshCheckRateLimit } = await import("./rate-limit");

    const result = await freshCheckRateLimit("account:acct-3", { limit: 5, windowMs: 60_000 });
    expect(result).toMatchObject({ success: true, remaining: 4, limit: 5 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("shared store unavailable"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with retry / X-RateLimit headers", async () => {
    const reset = Date.now() + 30_000;
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset,
      limit: 60,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // Reset already in the past — the ceiling math would otherwise give 0.
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset: Date.now() - 5_000,
      limit: 10,
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("RATE_LIMITS presets", () => {
  it("send and broadcast budgets are independent", async () => {
    __resetRateLimitForTests();
    // Importing here so the presets stay close to their assertions.
    const { RATE_LIMITS } = await import("./rate-limit");
    expect(RATE_LIMITS.send.limit).toBeGreaterThan(RATE_LIMITS.broadcast.limit);
    expect(RATE_LIMITS.send.windowMs).toBe(60_000);
    expect(RATE_LIMITS.broadcast.windowMs).toBe(60_000);
  });
});

afterEach(() => {
  __resetRateLimitForTests();
});
