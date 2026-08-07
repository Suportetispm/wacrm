import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { RECOVERY_COOKIE_NAME } from '@/lib/auth/recovery-cookie';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

// Server-side gate: only render the "set a new password" form when
// the visitor just came through a real recovery-link exchange (see
// /auth/callback). Anyone else — including an already logged-in user
// who just types this URL — gets sent to request a fresh link. This
// is a UX-level gate, not the security boundary by itself: the form
// itself re-checks for a live Supabase session before allowing a
// submit (see ResetPasswordForm).
export default async function ResetPasswordPage() {
  const cookieStore = await cookies();
  const hasRecoveryCookie = Boolean(cookieStore.get(RECOVERY_COOKIE_NAME)?.value);

  if (!hasRecoveryCookie) {
    redirect('/forgot-password?error=invalid_link');
  }

  return <ResetPasswordForm />;
}
