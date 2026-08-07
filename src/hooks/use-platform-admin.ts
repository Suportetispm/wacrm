"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

// ============================================================
// Client-side "am I a platform admin?" check — completely separate
// from useAuth()/AuthProvider (tenant profile/account/role). Never
// mixed with account_role: a tenant owner/admin is NOT a platform
// admin unless they're also explicitly in public.platform_admins.
//
// public.platform_admins has zero RLS policies for authenticated, so
// it can't be queried directly from the browser — this calls the
// is_platform_admin() SECURITY DEFINER RPC instead (see
// supabase/migrations/046_platform_admin_foundation.sql), the same
// sanctioned read path requirePlatformAdmin() uses server-side.
// ============================================================

export function usePlatformAdmin() {
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase.rpc("is_platform_admin").then(({ data, error }) => {
      if (cancelled) return;
      // Fail closed — a failed check never shows Superadmin-only UI.
      setIsPlatformAdmin(!error && data === true);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { isPlatformAdmin, loading };
}
