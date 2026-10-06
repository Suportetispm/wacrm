/**
 * Client-safe pieces of the contact WhatsApp avatar sync (no server
 * imports): the request/response contract of POST
 * /api/contacts/avatar-sync, the re-check interval, and how a stored
 * avatar is turned into an opaque cache-busting version for the UI.
 */

/** Minimum interval between two `/chat/avatar` queries for the same contact. */
export const AVATAR_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Max conversation ids accepted per POST /api/contacts/avatar-sync.
 * An internal WACRM safeguard (each id may cost one UAZAPI query and one
 * CDN download, run sequentially) — NOT a documented UAZAPI limit.
 */
export const AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST = 5

export type AvatarSyncResultStatus =
  | 'fresh'
  | 'updated'
  | 'unchanged'
  | 'no_photo'
  | 'no_photo_kept'
  | 'refused'
  | 'throttled'
  | 'transient_error'
  | 'database_error'
  | 'skipped_backoff'
  | 'skipped_in_flight'
  | 'skipped_invalid_input'
  | 'skipped_not_found'
  | 'skipped_no_connection'
  | 'skipped_provider'
  | 'skipped_no_contact'
  | 'not_found'
  | 'not_processed'

export interface AvatarSyncResult {
  conversationId: string
  contactId: string | null
  status: AvatarSyncResultStatus
  /**
   * The contact's avatar state AFTER this request, when known. `version`
   * is an opaque content-hash prefix (never the storage path); null =
   * no synced photo.
   */
  avatar: { version: string | null; checkedAt: string | null } | null
}

export interface AvatarSyncResponse {
  /** True when UAZAPI (or our own rate limit) asked us to slow down — the client stops its queue. */
  throttled: boolean
  results: AvatarSyncResult[]
}

const AVATAR_PATH_HASH = /([0-9a-f]{64})\.(?:jpg|png|webp)$/

/** Opaque cache-busting version derived from a stored avatar path (content-hash prefix), or null. */
export function avatarVersionFromPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  return AVATAR_PATH_HASH.exec(path)?.[1].slice(0, 16) ?? null
}

/** True when the contact was never checked, or its last check is older than the re-check interval. */
export function isAvatarCheckDue(checkedAt: string | null | undefined, now: number): boolean {
  if (!checkedAt) return true
  const t = Date.parse(checkedAt)
  return !Number.isFinite(t) || now - t >= AVATAR_RECHECK_INTERVAL_MS
}
