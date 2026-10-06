/**
 * Client-side queue for the Inbox contact-avatar background sync.
 *
 *   - Only conversations whose avatar check is due (never checked, or
 *     older than the re-check interval) AND that have a connection are
 *     enqueued — a stored photo is shown straight away, no request.
 *   - Each contact is requested at most once per queue lifetime (one
 *     Inbox page session): re-renders, list refetches and filter changes
 *     enqueue the same conversations again and are ignored.
 *   - Exactly one request in flight; batches of
 *     AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST, sent one after another.
 *   - Throttled (429) or any failed request stops the queue for good —
 *     no automatic retry in the same session.
 * No timers, no polling.
 */

import type { Conversation } from '@/types'
import {
  AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST,
  isAvatarCheckDue,
  type AvatarSyncResponse,
  type AvatarSyncResult,
} from './contact-avatar-sync-shared'

export type AvatarSyncSender = (conversationIds: string[]) => Promise<
  | { ok: true; response: AvatarSyncResponse }
  | { ok: false; throttled: boolean }
>

export interface AvatarSyncQueue {
  enqueue(conversations: readonly Conversation[]): void
  /** Stops the queue (unmount); a request already in flight is ignored when it lands. */
  dispose(): void
  readonly stopped: boolean
}

/** Conversations whose contact avatar should be (re)checked now. */
export function selectAvatarSyncCandidates(conversations: readonly Conversation[], now: number): Conversation[] {
  return conversations.filter((c) => {
    const contact = c.contact
    if (!contact?.id || !contact.phone) return false
    if (!c.whatsapp_config_id) return false
    return isAvatarCheckDue(contact.whatsapp_avatar_checked_at, now)
  })
}

export function createAvatarSyncQueue(opts: {
  send: AvatarSyncSender
  onResults: (results: AvatarSyncResult[]) => void
  now?: () => number
  batchSize?: number
}): AvatarSyncQueue {
  const now = opts.now ?? Date.now
  const batchSize = Math.min(opts.batchSize ?? AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST, AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST)
  const seenContacts = new Set<string>()
  const pending: string[] = []
  let running = false
  let stopped = false

  const drain = async () => {
    if (running) return
    running = true
    try {
      while (!stopped && pending.length > 0) {
        const batch = pending.splice(0, batchSize)
        let result: Awaited<ReturnType<AvatarSyncSender>>
        try {
          result = await opts.send(batch)
        } catch {
          result = { ok: false, throttled: false }
        }
        if (stopped) return
        if (!result.ok) {
          stopped = true
          return
        }
        if (result.response.results.length > 0) opts.onResults(result.response.results)
        if (result.response.throttled) {
          stopped = true
          return
        }
      }
    } finally {
      running = false
    }
  }

  return {
    enqueue(conversations) {
      if (stopped) return
      for (const c of selectAvatarSyncCandidates(conversations, now())) {
        const contactId = c.contact!.id
        if (seenContacts.has(contactId)) continue
        seenContacts.add(contactId)
        pending.push(c.id)
      }
      void drain()
    },
    dispose() {
      stopped = true
      pending.length = 0
    },
    get stopped() {
      return stopped
    },
  }
}

/**
 * Applies sync results to a conversation list: every conversation of a
 * returned contact gets the new avatar version/checked_at. Returns the
 * same array when nothing changed (no re-render).
 */
export function applyAvatarSyncResults(conversations: Conversation[], results: readonly AvatarSyncResult[]): Conversation[] {
  const byContact = new Map<string, NonNullable<AvatarSyncResult['avatar']>>()
  for (const r of results) if (r.contactId && r.avatar) byContact.set(r.contactId, r.avatar)
  if (byContact.size === 0) return conversations
  let changed = false
  const next = conversations.map((c) => {
    const patched = c.contact ? patchContactAvatar(c.contact, byContact) : c.contact
    if (patched === c.contact) return c
    changed = true
    return { ...c, contact: patched }
  })
  return changed ? next : conversations
}

/** Same patch for a single contact (the Inbox's separately-held active contact). */
export function applyAvatarSyncResultsToContact<T extends NonNullable<Conversation['contact']>>(
  contact: T | null,
  results: readonly AvatarSyncResult[],
): T | null {
  if (!contact) return contact
  const byContact = new Map<string, NonNullable<AvatarSyncResult['avatar']>>()
  for (const r of results) if (r.contactId && r.avatar) byContact.set(r.contactId, r.avatar)
  return patchContactAvatar(contact, byContact)
}

function patchContactAvatar<T extends NonNullable<Conversation['contact']>>(
  contact: T,
  byContact: Map<string, NonNullable<AvatarSyncResult['avatar']>>,
): T {
  const avatar = byContact.get(contact.id)
  if (!avatar) return contact
  const currentVersion = contact.whatsapp_avatar_version
  if (currentVersion === avatar.version && contact.whatsapp_avatar_checked_at === avatar.checkedAt) return contact
  return { ...contact, whatsapp_avatar_version: avatar.version, whatsapp_avatar_checked_at: avatar.checkedAt }
}
