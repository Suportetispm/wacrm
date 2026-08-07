import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  PlatformUnauthorizedError,
  requirePlatformAdmin,
} from "@/lib/auth/platform-admin";
import { AdminShell } from "@/components/admin/admin-shell";

// Never indexed — same posture as the tenant dashboard
// ((dashboard)/layout.tsx), doubly so here since this is the global
// admin surface.
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

// Server-side gate for the whole /admin tree. Deliberately uses
// requirePlatformAdmin() only — never getCurrentAccount()/requireRole()
// (@/lib/auth/account), and never treats a tenant owner/admin as
// authorized. This is the real authorization boundary; the "Superadmin"
// sidebar entry and the client-side usePlatformAdmin() hook are only
// UI conveniences on top of it.
//
// Redirect targets follow the app's existing convention (redirect,
// not a bare 403 page): no session at all → /login, same as every
// protected tenant route; authenticated but not a platform admin →
// /dashboard, the area they DO have access to — this doesn't reveal
// that /admin is a restricted zone, it just looks like being sent
// home.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof PlatformUnauthorizedError) {
      redirect("/login");
    }
    redirect("/dashboard");
  }

  return <AdminShell>{children}</AdminShell>;
}
