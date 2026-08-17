// ============================================================
// GET  /api/account/members
// POST /api/account/members
//
// GET  — lists every member of the caller's account. Any member can
//        call it (the Members tab is shown to admins+, but
//        agents/viewers see a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
//
// POST — creates a user directly inside the CALLER's own account:
//        auth.users + profile attached to that account, in one
//        guarded flow. Admin+ only (requireRole("admin")). Parallel
//        to the invite flow (POST /api/account/invitations) — never
//        replaces it, both stay available side by side.
//
//        Mirrors POST /api/admin/users (Superadmin, cross-tenant —
//        requirePlatformAdmin(), chooses any account) but this route
//        NEVER accepts an account_id from the client and NEVER calls
//        the Superadmin RPC: the target account is always
//        ctx.accountId, and the SECURITY DEFINER RPC
//        (create_account_member, 056_account_member_direct_creation.sql)
//        re-derives it a second time from auth.uid() itself — never
//        from a parameter — so a bug in this route could not widen
//        the target account even if it tried.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole, type AccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/account/admin-client";
import { compensateFailedUserCreation } from "@/lib/platform/user-compensation";
import { platformRpcErrorToResponse } from "@/lib/platform/rpc-errors";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import type { AccountMember } from "@/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
/** Never 'owner' — that role only changes via transfer_account_ownership (018). */
const CREATABLE_ROLES: readonly AccountRole[] = ["admin", "agent", "viewer"];

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  is_active: boolean;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email, avatar_url, account_role, is_active, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
          is_active: row.is_active,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface CreateMemberBody {
  full_name?: unknown;
  email?: unknown;
  password?: unknown;
  role?: unknown;
  queue_ids?: unknown;
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  // Same bucket as invitation create / role change / remove — this
  // is another admin-only member-management action on the same tab.
  const limit = checkRateLimit(`account:memberCreate:${ctx.userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as CreateMemberBody | null;

  const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";
  if (!fullName) return NextResponse.json({ error: "'full_name' is required" }, { status: 400 });
  if (fullName.length > 120) {
    return NextResponse.json({ error: "'full_name' must be 120 characters or fewer" }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid 'email' is required" }, { status: 400 });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `'password' must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  const roleInput = body?.role;
  if (!isAccountRole(roleInput) || !CREATABLE_ROLES.includes(roleInput)) {
    return NextResponse.json({ error: "'role' must be admin, agent or viewer" }, { status: 400 });
  }
  const role = roleInput;

  let queueIds: string[] | null = null;
  if (body?.queue_ids !== undefined) {
    if (!Array.isArray(body.queue_ids) || body.queue_ids.some((q) => typeof q !== "string" || !q)) {
      return NextResponse.json({ error: "'queue_ids' must be an array of strings" }, { status: 400 });
    }
    queueIds = [...new Set(body.queue_ids as string[])];
  }

  // Validate queues BEFORE touching auth.users — an error already
  // knowable up front should never cost an orphaned auth user needing
  // compensation below. RLS on queues already scopes this read to
  // ctx.accountId, no service role needed for it.
  if (queueIds && queueIds.length > 0) {
    const { data: matchedQueues } = await ctx.supabase
      .from("queues")
      .select("id")
      .eq("account_id", ctx.accountId)
      .in("id", queueIds);
    if ((matchedQueues ?? []).length !== queueIds.length) {
      return NextResponse.json(
        { error: "One or more queues do not belong to this account" },
        { status: 400 },
      );
    }
  }

  const admin = supabaseAdmin();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr || !created?.user) {
    const isConflict =
      createErr?.status === 422 || /already.*(registered|exists)/i.test(createErr?.message ?? "");
    if (isConflict) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
    }
    console.error("[POST /api/account/members] auth.admin.createUser failed:", createErr?.status);
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }

  const newUserId = created.user.id;

  const { error: attachErr } = await ctx.supabase.rpc("create_account_member", {
    p_user_id: newUserId,
    p_account_role: role,
    p_full_name: fullName,
    p_queue_ids: queueIds,
  });

  if (attachErr) {
    // Compensation: this auth user was created by THIS call.
    // handle_new_user() already gave it a temp personal account (+
    // auto-seeded catalog rows); compensateFailedUserCreation removes
    // that account first (accounts.owner_user_id is ON DELETE
    // RESTRICT) and only then the auth user itself — scoped to
    // owner_user_id = newUserId, so this can NEVER touch the
    // caller's real account, same guarantee as the Superadmin path
    // in /api/admin/users.
    const compensation = await compensateFailedUserCreation(admin, newUserId);
    if (!compensation.ok) {
      return NextResponse.json(
        {
          error:
            "Failed to finish creating the user, and automatic cleanup also failed. Contact an administrator.",
        },
        { status: 500 },
      );
    }
    // Generic SQLSTATE→HTTP mapper — despite living under lib/platform
    // it has no platform-specific behavior, just 42501/22023/23505
    // → 403/400/409. Reused as-is rather than duplicated.
    return platformRpcErrorToResponse(attachErr, "Failed to add user to your account");
  }

  return NextResponse.json({ user_id: newUserId }, { status: 201 });
}
