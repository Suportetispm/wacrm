/**
 * Syncs a contact's WhatsApp profile picture into our own private
 * storage (migration 085). Individual contacts only — never groups.
 *
 * Flow (run AFTER the inbound message is fully persisted, outside the
 * webhook response — see the route's `after()` wiring):
 *   contact (id + account_id) → checked_at fresh? stop
 *   → POST /chat/avatar (token of the SAME connection that received the
 *     message, chatId exactly as UAZAPI sent it, preview=true, no force)
 *   → url "" → clear whatsapp_avatar_path (webhook mode only — see below)
 *   → url → guarded download (whatsapp-avatar-fetch.ts) → sha256 of the
 *     CONTENT → `whatsapp-attachments/{account}/contacts/{contact}/{sha256}.{ext}`
 *     → update contacts → best-effort removal of the previous file.
 *
 * Modes:
 *   - 'webhook' (default): chatId is the real `message.chatid` UAZAPI
 *     just sent, so `url ""` is trusted and clears the stored photo.
 *   - 'background' (Inbox sync of existing conversations, POST
 *     /api/contacts/avatar-sync): chatId is the contact's stored phone,
 *     which may not be the exact variant WhatsApp identifies the chat by
 *     — so `url ""` NEVER removes an existing photo; it only marks the
 *     check done.
 *
 * Failure policy:
 *   - Definitive answers mark `whatsapp_avatar_checked_at` (normal 7-day
 *     interval): photo stored, same photo, no photo (`url ""` — path
 *     cleared in webhook mode, kept in background mode), and a 400/404
 *     from UAZAPI (current photo kept).
 *   - Everything else keeps the current photo and does NOT touch the
 *     database (no 7-day cooldown): transient failures (401, 429, 5xx,
 *     timeout, network, download HTTP error, upload, DB) and any refusal
 *     by the download security policy (a CDN/format change must not park
 *     the contact for a week). An in-memory per-contact backoff (1 h)
 *     avoids retrying on every message; it lives in this process only.
 *     A UAZAPI 429 is reported as 'throttled' (same side effects) so a
 *     batch caller can stop early.
 *
 * Never throws. Never logs URLs, phone/JID/chatId, tokens or names —
 * only fixed codes.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getChatAvatar, UazapiHttpError } from './uazapi-api'
import { fetchWhatsAppAvatarImage, WhatsAppAvatarFetchError, type AvatarImageFormat } from './whatsapp-avatar-fetch'
import { AVATAR_RECHECK_INTERVAL_MS } from '@/lib/inbox/contact-avatar-sync-shared'

const BUCKET = 'whatsapp-attachments'
const LOG_PREFIX = '[contact-avatar-sync]'

export { AVATAR_RECHECK_INTERVAL_MS }
export const AVATAR_TRANSIENT_BACKOFF_MS = 60 * 60 * 1000

const FORMAT_TO_EXTENSION: Record<AvatarImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' }
const FORMAT_TO_MIME: Record<AvatarImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Per-process state: retry-after timestamps for transient failures, and syncs currently running. */
const transientBackoffUntil = new Map<string, number>()
const inFlight = new Set<string>()

/** Test-only: clears the in-memory backoff / in-flight state. */
export function __resetContactAvatarSyncStateForTests(): void {
  transientBackoffUntil.clear()
  inFlight.clear()
}

export type ContactAvatarSyncOutcome =
  | 'skipped_invalid_input'
  | 'skipped_backoff'
  | 'skipped_in_flight'
  | 'skipped_not_found'
  | 'fresh'
  | 'no_photo'
  | 'no_photo_kept'
  | 'unchanged'
  | 'updated'
  | 'refused'
  | 'throttled'
  | 'transient_error'
  | 'database_error'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Individual chat ids only: a user JID, a LID, or bare digits. `@g.us` and every other suffix are refused. */
export function isIndividualChatId(chatId: string): boolean {
  const id = chatId.trim()
  if (id.length === 0 || id.endsWith('@g.us')) return false
  if (!id.includes('@')) return /^\d{6,20}$/.test(id)
  return id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')
}

/**
 * Reads `message.chatid` straight from the raw webhook body — the same
 * field every UAZAPI parser reads — so text messages (whose parser
 * doesn't expose a chatId) can trigger the sync too, without changing
 * any parser's contract. Returns null unless the event is an inbound,
 * human-sent, individual message.
 */
export function extractIndividualChatId(payload: unknown): string | null {
  if (!isRecord(payload) || payload.EventType !== 'messages') return null
  const message = payload.message
  if (!isRecord(message)) return null
  if (message.fromMe !== false) return null
  if (message.wasSentByApi === true) return null
  if (message.isGroup === true) return null
  const chat = isRecord(payload.chat) ? payload.chat : undefined
  if (chat?.wa_isGroup === true) return null
  const chatId = typeof message.chatid === 'string' ? message.chatid.trim() : ''
  return isIndividualChatId(chatId) ? chatId : null
}

/** The only storage prefix this module ever writes to or deletes from for a contact. */
function contactPrefix(accountId: string, contactId: string): string {
  return `${accountId}/contacts/${contactId}/`
}

function isOwnAvatarPath(path: unknown, accountId: string, contactId: string): path is string {
  if (typeof path !== 'string') return false
  return /^[^/]+\/contacts\/[^/]+\/[0-9a-f]{64}\.(jpg|png|webp)$/.test(path) && path.startsWith(contactPrefix(accountId, contactId))
}

function isStorageAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message.toLowerCase()
      : ''
  const statusCode = 'statusCode' in error ? String((error as { statusCode?: unknown }).statusCode) : ''
  return message.includes('already exists') || message.includes('duplicate') || statusCode === '409'
}

export interface SyncContactWhatsAppAvatarArgs {
  /** Service-role client (server only). */
  db: SupabaseClient
  accountId: string
  contactId: string
  /** Chat id exactly as UAZAPI sent it (or a number with DDI) — never reconstructed. */
  chatId: string
  /** 'webhook' (default) trusts `url ""` to clear the photo; 'background' never clears an existing one. */
  mode?: 'webhook' | 'background'
  /** Resolves the token of the SAME connection that received the message. Called only if a query is actually due. */
  getInstanceToken: () => Promise<string>
  now?: () => number
}

export async function syncContactWhatsAppAvatar(args: SyncContactWhatsAppAvatarArgs): Promise<ContactAvatarSyncOutcome> {
  const { db, accountId, contactId, chatId, getInstanceToken } = args
  const mode = args.mode ?? 'webhook'
  const now = args.now ?? Date.now

  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(contactId) || !isIndividualChatId(chatId)) {
    return 'skipped_invalid_input'
  }

  const key = `${accountId}:${contactId}`
  const backoffUntil = transientBackoffUntil.get(key)
  if (backoffUntil !== undefined) {
    if (now() < backoffUntil) return 'skipped_backoff'
    transientBackoffUntil.delete(key)
  }
  if (inFlight.has(key)) return 'skipped_in_flight'
  inFlight.add(key)

  const transient = (code: string): ContactAvatarSyncOutcome => {
    transientBackoffUntil.set(key, now() + AVATAR_TRANSIENT_BACKOFF_MS)
    console.error(LOG_PREFIX, 'transient_error', code)
    return 'transient_error'
  }

  // A failed DB read/write is transient too — back off instead of retrying on every message.
  const dbError = (): ContactAvatarSyncOutcome => {
    transientBackoffUntil.set(key, now() + AVATAR_TRANSIENT_BACKOFF_MS)
    return 'database_error'
  }

  const markChecked = async (): Promise<boolean> => {
    const { error } = await db
      .from('contacts')
      .update({ whatsapp_avatar_checked_at: new Date(now()).toISOString() })
      .eq('id', contactId)
      .eq('account_id', accountId)
    return !error
  }

  const removeBestEffort = async (path: string) => {
    if (!isOwnAvatarPath(path, accountId, contactId)) return
    const { error } = await db.storage.from(BUCKET).remove([path])
    if (error) console.error(LOG_PREFIX, 'cleanup_failed')
  }

  try {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id, account_id, whatsapp_avatar_path, whatsapp_avatar_checked_at')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (contactError) {
      console.error(LOG_PREFIX, 'contact_lookup_failed')
      return dbError()
    }
    if (!contact || contact.account_id !== accountId) return 'skipped_not_found'

    const checkedAt = contact.whatsapp_avatar_checked_at ? Date.parse(String(contact.whatsapp_avatar_checked_at)) : NaN
    if (Number.isFinite(checkedAt) && now() - checkedAt < AVATAR_RECHECK_INTERVAL_MS) return 'fresh'

    const currentPath: string | null = typeof contact.whatsapp_avatar_path === 'string' ? contact.whatsapp_avatar_path : null

    let token: string
    try {
      token = await getInstanceToken()
    } catch {
      return transient('token_unavailable')
    }

    let avatarUrl: string
    try {
      // preview=true: the photo is only ever shown as a small Inbox avatar.
      avatarUrl = (await getChatAvatar({ instanceToken: token, number: chatId, preview: true })).url
    } catch (err) {
      if (err instanceof UazapiHttpError && (err.status === 400 || err.status === 404)) {
        // Deterministic "can't resolve this chat" — don't re-ask on every message.
        console.error(LOG_PREFIX, 'refused', `uazapi_${err.status}`)
        return (await markChecked()) ? 'refused' : dbError()
      }
      if (err instanceof UazapiHttpError && err.status === 429) {
        transient('uazapi_429')
        return 'throttled'
      }
      return transient(err instanceof UazapiHttpError ? `uazapi_${err.status}` : 'uazapi_unreachable')
    } finally {
      token = ''
    }

    if (avatarUrl === '') {
      if (mode === 'background' && currentPath) {
        // The stored phone may not be the chat's exact WhatsApp id — an
        // empty answer is not proof the photo is gone. Keep it.
        return (await markChecked()) ? 'no_photo_kept' : dbError()
      }
      const { error } = await db
        .from('contacts')
        .update({ whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(now()).toISOString() })
        .eq('id', contactId)
        .eq('account_id', accountId)
      if (error) {
        console.error(LOG_PREFIX, 'contact_update_failed')
        return dbError()
      }
      if (currentPath) await removeBestEffort(currentPath)
      return 'no_photo'
    }

    let image: { buffer: Buffer; format: AvatarImageFormat }
    try {
      image = await fetchWhatsAppAvatarImage({ url: avatarUrl })
    } catch (err) {
      const code = err instanceof WhatsAppAvatarFetchError ? err.code : 'unknown'
      if (code === 'timeout' || code === 'network_error' || code === 'http_error' || code === 'unknown') {
        return transient(`download_${code}`)
      }
      // Our security policy refused the URL or the bytes (host, protocol,
      // port, credentials, redirect, MIME, signature, size). Keep the
      // current photo and DON'T mark checked_at — a legitimate future
      // CDN/format change must not park the contact for 7 days. Same
      // in-memory backoff as a transient failure.
      transientBackoffUntil.set(key, now() + AVATAR_TRANSIENT_BACKOFF_MS)
      console.error(LOG_PREFIX, 'refused', `download_${code}`)
      return 'refused'
    }

    const hash = createHash('sha256').update(image.buffer).digest('hex')
    const path = `${contactPrefix(accountId, contactId)}${hash}.${FORMAT_TO_EXTENSION[image.format]}`

    if (path === currentPath) {
      return (await markChecked()) ? 'unchanged' : dbError()
    }

    let uploadedThisRun = false
    const { error: uploadError } = await db.storage.from(BUCKET).upload(path, image.buffer, {
      contentType: FORMAT_TO_MIME[image.format],
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) {
      if (!isStorageAlreadyExistsError(uploadError)) return transient('upload_failed')
      // Same content already stored for this contact — reuse it.
    } else {
      uploadedThisRun = true
    }

    const { error: updateError } = await db
      .from('contacts')
      .update({ whatsapp_avatar_path: path, whatsapp_avatar_checked_at: new Date(now()).toISOString() })
      .eq('id', contactId)
      .eq('account_id', accountId)
    if (updateError) {
      console.error(LOG_PREFIX, 'contact_update_failed')
      if (uploadedThisRun) await removeBestEffort(path)
      return dbError()
    }

    if (currentPath && currentPath !== path) await removeBestEffort(currentPath)
    return 'updated'
  } catch {
    console.error(LOG_PREFIX, 'unexpected_error')
    return dbError()
  } finally {
    inFlight.delete(key)
  }
}
