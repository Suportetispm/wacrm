import { afterEach, describe, expect, it, vi } from "vitest";

// requirePlatformAdmin() must stay completely disjoint from tenant
// auth (@/lib/auth/account) — it never reads profiles/account_id,
// and a tenant owner/admin role carries zero weight here. The only
// source of truth is the is_platform_admin() RPC result, which this
// mock lets each test control independently of any notion of
// "tenant role" (there isn't one in this module).

interface FakeClientOpts {
  user: { id: string } | null;
  userErr?: unknown;
  isAdmin?: boolean;
  rpcErr?: unknown;
}

function makeClient(opts: FakeClientOpts) {
  const fromSpy = vi.fn();
  const rpcSpy = vi.fn(() =>
    Promise.resolve({ data: opts.isAdmin ?? false, error: opts.rpcErr ?? null }),
  );

  return {
    fromSpy,
    rpcSpy,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      rpc: rpcSpy,
      // Present so a bug that starts querying tables is caught
      // immediately by the "never touches profiles" test below,
      // instead of silently returning undefined.
      from: fromSpy,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const {
  requirePlatformAdmin,
  toPlatformErrorResponse,
  PlatformUnauthorizedError,
  PlatformForbiddenError,
} = await import("./platform-admin");

afterEach(() => {
  vi.clearAllMocks();
});

describe("requirePlatformAdmin", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const { client } = makeClient({ user: null });
    createClient.mockResolvedValue(client);

    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(PlatformUnauthorizedError);
  });

  it("rejects an authenticated caller who is not a platform admin (ordinary user) with 403", async () => {
    const { client } = makeClient({ user: { id: "user-1" }, isAdmin: false });
    createClient.mockResolvedValue(client);

    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(PlatformForbiddenError);
  });

  it("a tenant owner is NOT automatically a platform admin — tenant role is never consulted", async () => {
    // No tenant role is ever passed in here; the module has no
    // concept of one. is_platform_admin() answering false is the
    // only thing that matters, regardless of what the caller's
    // account_role happens to be in a completely separate table.
    const { client, fromSpy } = makeClient({ user: { id: "owner-1" }, isAdmin: false });
    createClient.mockResolvedValue(client);

    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(PlatformForbiddenError);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("a tenant admin is NOT automatically a platform admin — same as above", async () => {
    const { client } = makeClient({ user: { id: "admin-1" }, isAdmin: false });
    createClient.mockResolvedValue(client);

    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(PlatformForbiddenError);
  });

  it("recognizes a real platform admin and returns a minimal context", async () => {
    const { client } = makeClient({ user: { id: "super-1" }, isAdmin: true });
    createClient.mockResolvedValue(client);

    // toEqual (não toMatchObject) de propósito: o contexto retornado
    // precisa ser exatamente { userId }, sem nenhum campo a mais
    // (como um client Supabase) vazando para quem chamar isso.
    const ctx = await requirePlatformAdmin();
    expect(ctx).toEqual({
      userId: "super-1",
    });
  });

  it("fails closed (403, not a crash) if the is_platform_admin RPC itself errors", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      rpcErr: { message: "connection reset" },
    });
    createClient.mockResolvedValue(client);

    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(PlatformForbiddenError);
  });

  it("never queries any table — no account_id/profiles lookup of any kind", async () => {
    const { client, fromSpy } = makeClient({ user: { id: "super-1" }, isAdmin: true });
    createClient.mockResolvedValue(client);

    await requirePlatformAdmin();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("calls is_platform_admin with no arguments — never passes a client-supplied user id", async () => {
    const { client, rpcSpy } = makeClient({ user: { id: "super-1" }, isAdmin: true });
    createClient.mockResolvedValue(client);

    await requirePlatformAdmin();
    expect(rpcSpy).toHaveBeenCalledWith("is_platform_admin");
  });
});

describe("toPlatformErrorResponse", () => {
  it("maps PlatformUnauthorizedError to 401", async () => {
    const res = toPlatformErrorResponse(new PlatformUnauthorizedError());
    expect(res.status).toBe(401);
  });

  it("maps PlatformForbiddenError to 403", async () => {
    const res = toPlatformErrorResponse(new PlatformForbiddenError());
    expect(res.status).toBe(403);
  });

  it("collapses an uncategorized error to a generic 500 (no internal details leaked)", async () => {
    const res = toPlatformErrorResponse(new Error("some internal detail"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
