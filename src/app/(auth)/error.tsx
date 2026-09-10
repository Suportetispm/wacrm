"use client";

// Catches render errors from the public auth pages (login, signup,
// forgot/reset password). AuthLayout has no shell/chrome of its own
// (it just passes children through), so this is the only fallback UI
// a visitor would otherwise get here if a page crashed.
import { ErrorBoundaryFallback } from "@/components/error-boundary-fallback";

export default function AuthSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundaryFallback error={error} reset={reset} />;
}
