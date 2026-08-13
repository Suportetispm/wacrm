/**
 * Persistence for a parsed inbound UAZAPI PDF document message.
 *
 * FASE 3.1: this module is fully built and tested but NOT called from
 * the live webhook route yet — see the route's own comments for what
 * it currently does (still text-only, migration 038's RPC). Wiring
 * this in is a deliberately separate, later step.
 *
 * Contact/conversation find-or-create is a self-contained duplicate of
 * `uazapi-webhook-persist.ts`'s private helpers (not imported — that
 * module doesn't export them, and this stage's scope explicitly
 * excludes touching the text path). Message insert + conversation
 * advance is a single RPC (`uazapi_persist_inbound_document_message`,
 * migration 042, not yet applied) mirroring
 * `uazapi_persist_inbound_text_message`'s atomicity/dedup guarantees
 * exactly — same `(conversation_id, message_id)` unique index from
 * migration 038, no new index needed.
 *
 * Never accepts or forwards UAZAPI's `fileURL`, `mediaKey`,
 * `directPath`, any WhatsApp crypto hash, or the raw base64 payload
 * into a log line — the decoded file buffer is held only as long as
 * needed to check its signature and upload it, then discarded.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  downloadMessageMedia,
  estimateBase64DecodedBytes,
  UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES,
  UazapiHttpError,
} from './uazapi-api'
import { resolveCanonicalPhone } from './uazapi-webhook-identity'
import type { ParsedInboundDocumentMessage } from './uazapi-webhook-document-parser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const BUCKET = 'whatsapp-attachments'
const PDF_SIGNATURE = '%PDF-'

export interface PersistInboundDocumentMessageArgs {
  db: SupabaseClient
  accountId: string
  /** Audit FK for inserts that require one — same convention as the text path. */
  configOwnerUserId: string
  /** Already-decrypted UAZAPI instance token — decryption stays the caller's job, same as the route's existing pattern. */
  instanceToken: string
  parsed: ParsedInboundDocumentMessage
}

export type PersistInboundDocumentOutcome =
  | { outcome: 'persisted' }
  | { outcome: 'duplicate' }
  | {
      outcome: 'error'
      code:
        | 'contact_failed'
        | 'conversation_failed'
        | 'download_failed'
        | 'validation_failed'
        | 'upload_failed'
        | 'database_failed'
    }

/** Postgres SQLSTATE, when available — never the error message text. */
function sqlStateOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

type DatabaseErrorCode =
  | 'rpc_not_found'
  | 'rpc_permission_denied'
  | 'constraint_violation'
  | 'invalid_argument'
  | 'database_failed'
  | 'unknown_database_error'

/** Same classification buckets as `uazapi-webhook-persist.ts` — reads only `error.code`, never `.message`. */
function classifyDatabaseError(error: unknown): DatabaseErrorCode {
  const code = sqlStateOf(error)
  if (code === 'unknown_error') return 'unknown_database_error'
  if (code === 'PGRST202' || code === 'PGRST301') return 'rpc_not_found'
  if (code === '42501') return 'rpc_permission_denied'
  if (code.startsWith('23')) return 'constraint_violation'
  if (code === '22P02' || code === '42883' || code.startsWith('22')) return 'invalid_argument'
  return 'database_failed'
}

/** True for a Supabase Storage "object already exists" response — the signal we treat as a benign retry/race, never as a hard failure. Checked defensively (message text + statusCode) since supabase-js doesn't expose a typed discriminant for this. */
function isStorageAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message.toLowerCase()
      : ''
  const statusCode =
    'statusCode' in error ? String((error as { statusCode?: unknown }).statusCode) : ''
  return message.includes('already exists') || message.includes('duplicate') || statusCode === '409'
}

/** Strict base64 charset check, run BEFORE any size estimate or
 * `Buffer.from` call. Node's base64 decoder is lenient — it silently
 * drops whitespace, newlines, and any other non-base64 characters
 * (e.g. a `data:application/pdf;base64,` URI prefix) rather than
 * throwing, which would make `estimateBase64DecodedBytes`'s
 * length-based arithmetic wrong (it assumes every character is a real
 * base64 character). Rejecting anything outside the strict alphabet
 * up front keeps that arithmetic trustworthy and closes the
 * whitespace/data-URI gap outright instead of trying to detect it
 * after the fact. */
function isValidBase64Charset(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Same field priority and LID-vs-phone classification as the text
 * path (`uazapi-webhook-parser.ts`), via the shared resolver — see
 * `uazapi-webhook-identity.ts` for the rationale. `lidDetected` is
 * surfaced (not currently logged here) so a future diagnostic can
 * distinguish "no phone, saw a LID" from "no phone, nothing usable at
 * all" without ever writing the LID's digits anywhere.
 */
function extractPhone(parsed: ParsedInboundDocumentMessage): {
  phone: string | null
  lidDetected: boolean
} {
  return resolveCanonicalPhone([
    parsed.senderPn,
    parsed.sender,
    parsed.chatPhone,
    parsed.chatId,
    parsed.chatWaChatid,
  ])
}

/**
 * Deterministic, multitenant, sanitized storage path — never the raw
 * `providerMessageId` (attacker/provider-controlled string) or the
 * original filename. Hashing `providerMessageId` also makes a webhook
 * redelivery of the SAME message land on the exact same path instead
 * of creating a new object each retry (see the concurrency notes on
 * `persistInboundDocumentMessage` below).
 *
 * `accountId`/`conversationId` are expected to always be UUIDs (both
 * come straight from Supabase-generated primary keys) — validated
 * here defensively rather than trusted blindly, since they're
 * interpolated directly into a Storage object key. Returns `null`
 * (never a best-effort fallback path) if either isn't UUID-shaped.
 */
function buildStoragePath(
  accountId: string,
  conversationId: string,
  providerMessageId: string,
): string | null {
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(conversationId)) return null
  const hash = createHash('sha256').update(providerMessageId).digest('hex')
  return `${accountId}/${conversationId}/${hash}.pdf`
}

/**
 * Finds or creates the contact + conversation, checks for a known
 * duplicate cheaply (before spending a download+upload on a webhook
 * redelivery), downloads and validates the real file, uploads it to
 * the private bucket, then persists via RPC.
 *
 * Concurrency: two webhook deliveries for the SAME message
 * (`providerMessageId`) racing each other both compute the same
 * deterministic storage path (same source bytes either way, since the
 * id is the same). Whichever's upload lands first "wins" the object;
 * the other observes an "already exists" response and treats it as
 * informational, never as a reason to fail or to delete anything. The
 * RPC's `ON CONFLICT (conversation_id, message_id) DO NOTHING` is the
 * actual source of truth for which one "wins" the message row —
 * independent of upload ordering, so there is no window where the
 * loser's RPC call could double-count `unread_count` or clobber
 * `last_message_at`.
 *
 * Orphan prevention: the best-effort Storage cleanup below only ever
 * runs when THIS execution's own upload call reported success
 * (`uploadedThisRun`) — an object found via "already exists" is never
 * a candidate for deletion, because it may belong to a concurrent
 * execution that's about to succeed, or to an already-persisted
 * message from an earlier successful attempt.
 */
export async function persistInboundDocumentMessage({
  db,
  accountId,
  configOwnerUserId,
  instanceToken,
  parsed,
}: PersistInboundDocumentMessageArgs): Promise<PersistInboundDocumentOutcome> {
  const { phone } = extractPhone(parsed)
  if (!phone) return { outcome: 'error', code: 'contact_failed' }

  const contact = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    phone,
    parsed.senderName ?? phone,
  )
  if (!contact) return { outcome: 'error', code: 'contact_failed' }

  const conversation = await findOrCreateConversation(db, accountId, configOwnerUserId, contact.id)
  if (!conversation) return { outcome: 'error', code: 'conversation_failed' }

  // Tenancy: `findOrCreateConversation` already scopes its query by
  // `.eq('account_id', accountId)`, so this should be unreachable in
  // practice — re-verified explicitly anyway, since both the storage
  // path and the RPC's `p_conversation_id` are about to be derived
  // from `conversation` below. This is the "derive tenancy from the
  // resolved conversation row" approach, preferred over trusting the
  // caller-supplied `accountId` alone (the RPC itself deliberately
  // does NOT take an `account_id` parameter, for the same reason — a
  // second, independently-suppliable copy of tenancy is a second
  // place it could drift from the truth).
  if (conversation.account_id !== accountId) {
    console.error(
      '[uazapi/webhook:document-persist] resolved conversation does not belong to the expected account',
    )
    return { outcome: 'error', code: 'conversation_failed' }
  }

  // Cheap known-duplicate short-circuit — purely an optimization to
  // skip a download+upload on a known retry. Correctness never depends
  // on this: the RPC's ON CONFLICT below is authoritative regardless.
  const { data: existingRow, error: existingError } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', parsed.providerMessageId)
    .maybeSingle()
  if (existingError) {
    console.error(
      '[uazapi/webhook:document-persist] known-duplicate check failed:',
      classifyDatabaseError(existingError),
    )
    // Not fatal — fall through, the RPC still guards correctness.
  } else if (existingRow) {
    return { outcome: 'duplicate' }
  }

  let downloadResult: Awaited<ReturnType<typeof downloadMessageMedia>>
  try {
    downloadResult = await downloadMessageMedia({
      instanceToken,
      id: parsed.providerDownloadId,
      returnBase64: true,
    })
  } catch (err) {
    if (err instanceof UazapiHttpError) {
      console.error('[uazapi/webhook:document-persist] download failed, status:', err.status)
    } else {
      console.error(
        '[uazapi/webhook:document-persist] download failed:',
        err instanceof Error ? err.name : 'unknown',
      )
    }
    return { outcome: 'error', code: 'download_failed' }
  }

  if (!downloadResult.base64Data) {
    // FASE 3.1 decision: never fall back to fetching `fileUrl`
    // server-side (UAZAPI-hosted, only a 2-day retention, and an
    // unreviewed SSRF-shaped surface) — fail closed instead.
    console.error('[uazapi/webhook:document-persist] download returned no base64Data')
    return { outcome: 'error', code: 'download_failed' }
  }

  // Format check BEFORE any size estimate or decode — see
  // `isValidBase64Charset`'s docstring for why (whitespace/data-URI
  // gap). `parsed.fileSize` (UAZAPI's declared `content.fileLength`,
  // used only by the parser as a fast upper-bound reject before any
  // network call) is intentionally never compared against the real
  // downloaded size here: minor divergence between "declared" and
  // "actual" is expected and harmless on its own — `decodedSize`
  // below (computed from the real download) is what's authoritative
  // for both the size cap and what's ultimately persisted as
  // `media_file_size`.
  if (!isValidBase64Charset(downloadResult.base64Data)) {
    return { outcome: 'error', code: 'validation_failed' }
  }

  // Defense in depth — downloadMessageMedia already enforces this
  // internally, but this module doesn't assume that will always stay true.
  const decodedSize = estimateBase64DecodedBytes(downloadResult.base64Data)
  if (decodedSize <= 0 || decodedSize > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) {
    return { outcome: 'error', code: 'validation_failed' }
  }

  let buffer: Buffer | undefined = Buffer.from(downloadResult.base64Data, 'base64')
  try {
    // Real allocated size, re-checked against the same cap post-decode
    // (not just the pre-decode estimate) — with the strict charset
    // check above this should always match `decodedSize` exactly, but
    // this is the actual bytes that are about to be uploaded, so it's
    // verified independently rather than assumed.
    if (buffer.length > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) {
      return { outcome: 'error', code: 'validation_failed' }
    }
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== PDF_SIGNATURE) {
      // Never trust the declared mimetype (or the .pdf extension) alone.
      return { outcome: 'error', code: 'validation_failed' }
    }
    if (downloadResult.mimetype && downloadResult.mimetype !== 'application/pdf') {
      return { outcome: 'error', code: 'validation_failed' }
    }

    const path = buildStoragePath(accountId, conversation.id, parsed.providerMessageId)
    if (!path) {
      console.error(
        '[uazapi/webhook:document-persist] refusing to build a storage path from a non-UUID account/conversation id',
      )
      return { outcome: 'error', code: 'validation_failed' }
    }

    let uploadedThisRun = false
    const { error: uploadError } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: 'application/pdf',
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) {
      if (!isStorageAlreadyExistsError(uploadError)) {
        console.error('[uazapi/webhook:document-persist] upload failed')
        return { outcome: 'error', code: 'upload_failed' }
      }
      // Pre-existing object (retry/race) — never deleted by this run.
    } else {
      uploadedThisRun = true
    }

    const { data: rpcResult, error: rpcError } = await db.rpc(
      'uazapi_persist_inbound_document_message',
      {
        p_conversation_id: conversation.id,
        p_message_id: parsed.providerMessageId,
        p_content_text: parsed.caption ?? parsed.fileName,
        p_occurred_at: parsed.occurredAt,
        p_media_storage_path: path,
        p_media_file_name: parsed.fileName,
        p_media_mime_type: 'application/pdf',
        p_media_file_size: decodedSize,
        p_media_metadata: parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {},
      },
    )

    if (rpcError) {
      console.error('[uazapi/webhook:document-persist] rpc failed:', classifyDatabaseError(rpcError))
      if (uploadedThisRun) {
        // Race guard: THIS execution's RPC call failed, but a
        // concurrent execution racing on the same providerMessageId
        // may have already succeeded (its "already exists" upload
        // pointed at the object THIS run just created, and its RPC
        // call landed first). Deleting unconditionally here would
        // corrupt that other execution's now-valid, already-persisted
        // message. Re-check before deleting — a short TOCTOU window
        // remains between this check and the delete below, accepted
        // as a narrow residual risk; the alternative (skip cleanup
        // entirely) leaves a permanent orphan on every genuine failure
        // instead of this rare worst case.
        const { data: raceCheck } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('message_id', parsed.providerMessageId)
          .maybeSingle()
        if (!raceCheck) {
          const { error: cleanupError } = await db.storage.from(BUCKET).remove([path])
          if (cleanupError) {
            console.error('[uazapi/webhook:document-persist] best-effort cleanup failed')
          }
        }
      }
      return { outcome: 'error', code: 'database_failed' }
    }

    if (rpcResult === 'persisted') return { outcome: 'persisted' }
    if (rpcResult === 'duplicate') return { outcome: 'duplicate' }

    console.error('[uazapi/webhook:document-persist] rpc returned an unexpected value')
    return { outcome: 'error', code: 'database_failed' }
  } finally {
    // Discard the decoded file content as soon as this function is done
    // with it — never held longer than necessary, never logged.
    buffer = undefined
  }
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<Row | null> {
  const existing = await findExistingContact(db, accountId, phone)
  if (existing) return existing

  const { data: created, error } = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: configOwnerUserId, phone, name })
    .select()
    .single()

  if (!error) return created

  if (isUniqueViolation(error)) {
    return await findExistingContact(db, accountId, phone)
  }
  console.error('[uazapi/webhook:document-persist] contact insert failed:', classifyDatabaseError(error))
  return null
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
): Promise<Row | null> {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error(
      '[uazapi/webhook:document-persist] conversation lookup failed:',
      classifyDatabaseError(findError),
    )
    return null
  }
  if (existingRows && existingRows.length > 0) return existingRows[0]

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contactId })
    .select()
    .single()

  if (!createError) return created

  if (isUniqueViolation(createError)) {
    const { data: raced } = await db
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (raced && raced.length > 0) return raced[0]
  }
  console.error(
    '[uazapi/webhook:document-persist] conversation insert failed:',
    classifyDatabaseError(createError),
  )
  return null
}
