import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Shared cleanup for a user-creation flow that created an
// auth.users row but failed before finishing its intended account
// link (POST /api/admin/users -> platform_attach_user_to_account, or
// POST /api/admin/accounts -> platform_create_account with a
// freshly-created owner).
//
// handle_new_user() (017_account_sharing.sql) unconditionally creates
// a personal `accounts` row + owner `profiles` row for EVERY
// auth.users insert, including ones made server-side via
// admin.auth.admin.createUser() — there is no branch that skips this
// for admin-created users. If the follow-up RPC then fails, that temp
// account/profile is still there. Deleting the auth user directly at
// that point fails: accounts.owner_user_id is ON DELETE RESTRICT, and
// this user still owns that temp account.
//
// Deleting the temp account FIRST — scoped to owner_user_id = userId,
// so this can never touch any account this user doesn't own — cascades
// away the profile (profiles.account_id ON DELETE CASCADE) and
// anything auto-seeded for it (e.g. internal_ticket_* catalog rows,
// all FK'd to accounts ON DELETE CASCADE) in a single statement. Only
// then is deleting the auth user safe.
// ============================================================

export interface CompensationResult {
  /** true once the auth user (and any temp account it owned) is gone. */
  ok: boolean
}

export async function compensateFailedUserCreation(
  admin: SupabaseClient,
  userId: string,
): Promise<CompensationResult> {
  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (profile?.account_id) {
    await admin.from('accounts').delete().eq('id', profile.account_id).eq('owner_user_id', userId)
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)
  if (deleteErr) {
    console.error(
      '[compensateFailedUserCreation] deleteUser failed after cleanup attempt; manual cleanup required for user',
      userId,
    )
    return { ok: false }
  }
  return { ok: true }
}
