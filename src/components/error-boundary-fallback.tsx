"use client";

// Shared UI for every route-segment error.tsx in this app (top-level,
// (dashboard), (auth), admin — see each for why they exist
// separately). Each one renders inside its own segment's layout, so
// this only needs to fill the failing content area, not provide
// full-page navigation — the dashboard/admin sidebars stay visible
// and already give the user a way out.
//
// Deliberately does NOT render `error.message` or `error.stack`
// anywhere — those can carry Postgres/backend detail (see the
// GENERIC_ERROR/sqlCode() pattern already used across the API routes
// for the same reason). The only thing shown from `error` is
// `error.digest`, Next.js's own opaque per-error reference id for
// Server Component errors — safe to display, never contains message
// content — so a user can quote it to support without us leaking
// anything ourselves.
//
// global-error.tsx (root-layout failures) intentionally does NOT use
// this component: it replaces <html>/<body> entirely, so the
// NextIntlClientProvider this component depends on (mounted inside
// the root layout) isn't available to it.

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface ErrorBoundaryFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function ErrorBoundaryFallback({
  error,
  reset,
}: ErrorBoundaryFallbackProps) {
  const t = useTranslations("ErrorBoundary");

  useEffect(() => {
    // Browser devtools console only — never rendered into the page,
    // never sent anywhere else. Same visibility the user already has
    // into their own browser; not a leak to any other party.
    console.error("[error-boundary]", error);
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-[60vh] items-center justify-center px-4 py-12"
    >
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
            <AlertTriangle
              className="h-6 w-6 text-destructive"
              aria-hidden="true"
            />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <Button onClick={reset} className="w-full">
            {t("retry")}
          </Button>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              {t("reference", { digest: error.digest })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
