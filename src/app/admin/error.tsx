"use client";

// Catches render errors from the superadmin area (accounts, users,
// audit). Rendered inside AdminLayout, so AdminShell's nav stays
// mounted — same rationale as (dashboard)/error.tsx. Does NOT catch a
// failure in admin/layout.tsx itself (its requirePlatformAdmin()
// call) — that bubbles up to the root src/app/error.tsx instead.
import { ErrorBoundaryFallback } from "@/components/error-boundary-fallback";

export default function AdminSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundaryFallback error={error} reset={reset} />;
}
