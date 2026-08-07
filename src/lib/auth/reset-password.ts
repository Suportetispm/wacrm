// ============================================================
// Pure validation + submission logic for the "set a new password"
// step of the password-recovery flow. Kept outside the client
// component so it's unit-testable without a DOM.
// ============================================================

/** Mirrors the minimum length already enforced on the logged-in
 *  change-password form (Settings → Profile) — kept as an
 *  independent constant here since that form lives in a different
 *  module this fix doesn't touch. */
export const MIN_PASSWORD = 8;

export type PasswordValidationError = 'too_short' | 'mismatch';

export function validateNewPassword(
  password: string,
  confirm: string,
  minLength: number = MIN_PASSWORD,
): PasswordValidationError | null {
  if (password.length < minLength) return 'too_short';
  if (password !== confirm) return 'mismatch';
  return null;
}

export type ResetPasswordError = PasswordValidationError | 'update_failed';

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: ResetPasswordError };

/** The slice of the Supabase auth client this flow actually needs —
 *  narrowed so tests can pass a plain fake instead of a real client. */
export interface UpdatePasswordAuthClient {
  updateUser: (attrs: { password: string }) => Promise<{ error: { message: string } | null }>;
}

/**
 * Validate, then (only if valid) call `updateUser`. Never sends the
 * password anywhere but this one call — no query strings, no logs.
 */
export async function submitNewPassword(
  auth: UpdatePasswordAuthClient,
  password: string,
  confirm: string,
  minLength: number = MIN_PASSWORD,
): Promise<ResetPasswordResult> {
  const validationError = validateNewPassword(password, confirm, minLength);
  if (validationError) return { ok: false, error: validationError };

  const { error } = await auth.updateUser({ password });
  if (error) return { ok: false, error: 'update_failed' };

  return { ok: true };
}
