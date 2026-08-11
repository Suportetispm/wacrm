import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountDisabledError, getCurrentAccount } from "@/lib/auth/account";
import { DashboardShell } from "./dashboard-shell";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// is_active gate (FASE 6C.3C) — RLS (is_account_member(), migration
// 048) already blocks every data operation for a deactivated
// profile, but that alone leaves the user staring at a broken/empty
// dashboard after a normal login. This is the one shared entry point
// for every (dashboard) route, so it's the minimal central place to
// turn that into a clean redirect instead.
//
// Deliberately narrow: only AccountDisabledError is acted on. Every
// other failure mode from getCurrentAccount() — no session,
// orphaned/pre-migration profile, a transient DB read error — is
// swallowed exactly as before this gate existed, so DashboardShell's
// own client-side `useAuth()` redirect-to-/login and every other
// pre-existing edge case keep behaving unchanged. Platform admins are
// unaffected: /admin never calls getCurrentAccount() (see
// src/app/admin/layout.tsx), and an owner/admin/agent profile can
// never be set is_active=false through the new platform_update_user
// RPC (it only ever touches admin/agent profiles it created — see
// 048_platform_user_management.sql).
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await getCurrentAccount();
  } catch (err) {
    if (err instanceof AccountDisabledError) {
      redirect("/account-disabled");
    }
    // Anything else: fall through unchanged, same as before this gate.
  }

  return <DashboardShell>{children}</DashboardShell>;
}
