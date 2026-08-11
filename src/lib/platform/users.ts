// ============================================================
// Shared read-side helpers for /api/admin/users/**.
//
// Superadmin user management only ever manages profiles with
// account_role IN ('admin', 'agent') — owner is a technical/
// structural role (see transfer_account_ownership, 018) and viewer
// is not exposed in this product surface. Both are treated as "not
// found" by this module, never partially exposed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const MANAGED_ACCOUNT_ROLES = ['admin', 'agent'] as const
export type ManagedAccountRole = (typeof MANAGED_ACCOUNT_ROLES)[number]

export function isManagedAccountRole(value: unknown): value is ManagedAccountRole {
  return typeof value === 'string' && (MANAGED_ACCOUNT_ROLES as readonly string[]).includes(value)
}

export interface PlatformUserQueue {
  id: string
  name: string
  color: string
}

export interface PlatformUser {
  id: string
  full_name: string
  email: string
  account: { id: string; name: string }
  account_role: ManagedAccountRole
  is_active: boolean
  queues: PlatformUserQueue[]
  created_at: string
}

/**
 * Loads one user's sanitized platform-admin representation via the
 * service-role client (cross-tenant reads are only legitimate once
 * requirePlatformAdmin() has already authorized the caller — see
 * every route in src/app/api/admin/users/**).
 *
 * Returns null when the profile doesn't exist, its account is
 * missing, or its role is outside admin|agent — callers should treat
 * all three as a 404, never distinguish them (avoids leaking whether
 * an id belongs to an owner/viewer profile).
 */
export async function fetchPlatformUser(
  admin: SupabaseClient,
  userId: string,
): Promise<PlatformUser | null> {
  const { data: profile } = await admin
    .from('profiles')
    .select('user_id, full_name, email, account_id, account_role, is_active, created_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (!profile || !isManagedAccountRole(profile.account_role)) return null

  const { data: account } = await admin
    .from('accounts')
    .select('id, name')
    .eq('id', profile.account_id)
    .maybeSingle()

  if (!account) return null

  const { data: memberships } = await admin
    .from('queue_members')
    .select('queue_id')
    .eq('user_id', userId)
    .eq('account_id', profile.account_id)

  const queueIds = [...new Set((memberships ?? []).map((m) => m.queue_id as string))]
  let queues: PlatformUserQueue[] = []
  if (queueIds.length > 0) {
    const { data: queueRows } = await admin
      .from('queues')
      .select('id, name, color')
      .in('id', queueIds)
    queues = queueRows ?? []
  }

  return {
    id: profile.user_id,
    full_name: profile.full_name,
    email: profile.email,
    account: { id: account.id, name: account.name },
    account_role: profile.account_role,
    is_active: profile.is_active,
    queues,
    created_at: profile.created_at,
  }
}
