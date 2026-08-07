// ============================================================
// Short-lived marker cookie set by /auth/callback right after a
// password-recovery code exchange succeeds. /reset-password checks
// for it before rendering the "set a new password" form, so an
// already logged-in user can't reach that form just by typing the
// URL — they'd need to have actually come from a real recovery
// email link within the last RECOVERY_COOKIE_MAX_AGE_SECONDS.
//
// The cookie carries no sensitive data (a constant flag value); the
// real auth boundary is still the Supabase session established
// during the code exchange, which the reset-password form itself
// re-checks client-side before allowing a submit.
// ============================================================

export const RECOVERY_COOKIE_NAME = 'sb-recovery-pending';
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 10 * 60;
export const RECOVERY_COOKIE_PATH = '/reset-password';
