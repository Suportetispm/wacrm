"use client";

// /account-disabled — landed on by src/app/(dashboard)/layout.tsx
// when getCurrentAccount() throws AccountDisabledError
// (profiles.is_active = false, migration
// 048_platform_user_management.sql). Standalone route (not under the
// (dashboard) or (auth) route groups): the visitor is authenticated
// but must not be able to reach any tenant area, so it can't live
// inside DashboardShell, and it isn't a signed-out flow either.
//
// Shows no account-specific detail (name, company, role) — the
// message is intentionally generic, same posture as every other
// platform-auth error path in this codebase (see
// src/lib/auth/platform-admin.ts's sanitized error responses).

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Lock } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function AccountDisabledPage() {
  const t = useTranslations("AccountDisabled");
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      // Full navigation (not router.push) so no stale client state
      // from this session survives onto /login — mirrors
      // useAuth().signOut() in src/hooks/use-auth.tsx.
      window.location.href = "/login";
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
            <Lock className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle className="text-xl text-foreground">{t("title")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full"
          >
            {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("signOut")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
