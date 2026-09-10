"use client";

// Catches render errors in routes that sit directly under the app
// root — `/`, `/account-disabled`, `/join/[token]` — and also acts as
// the safety net for a `layout.tsx` failure inside (dashboard), (auth)
// or admin: a segment's own error.tsx (see each) does NOT catch an
// error thrown by that SAME segment's layout, only by its page/children
// — so a failure in e.g. (dashboard)/layout.tsx's getCurrentAccount()
// call bubbles up to this boundary instead. Still wrapped by the root
// layout (app/layout.tsx), so NextIntlClientProvider is available.
import { ErrorBoundaryFallback } from "@/components/error-boundary-fallback";

export default function RootSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundaryFallback error={error} reset={reset} />;
}
