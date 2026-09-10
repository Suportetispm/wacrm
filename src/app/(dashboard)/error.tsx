"use client";

// Catches render errors from any page under the (dashboard) route
// group (inbox, tickets, flows, automations, contacts, etc. — the
// main day-to-day work area). Rendered inside DashboardLayout, so
// DashboardShell's sidebar/nav stays mounted and usable — the user
// isn't stranded on a blank page, they can navigate elsewhere while
// this segment recovers.
//
// Does NOT catch a failure in (dashboard)/layout.tsx itself (e.g. its
// getCurrentAccount() call) — that bubbles up to the root
// src/app/error.tsx instead, per Next.js's error.tsx scoping rules.
import { ErrorBoundaryFallback } from "@/components/error-boundary-fallback";

export default function DashboardSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundaryFallback error={error} reset={reset} />;
}
