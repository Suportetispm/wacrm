/**
 * Persistence for a parsed inbound UAZAPI image message.
 *
 * FASE 4C. Mirrors `uazapi-webhook-document-persist.ts`'s structure,
 * guarantees, and concurrency reasoning exactly, adapted for images:
 * same private `whatsapp-attachments` bucket (migration 043 widened
 * its `allowed_mime_types`), same deterministic per-account/
 * per-conversation storage path, same download → validate → upload →
 * RPC pipeline, same orphan-cleanup race guard.
 *
 * Contact/conversation find-or-create is a self-contained duplicate of
 * `uazapi-webhook-persist.ts` / `uazapi-webhook-document-persist.ts`'s
 * private helpers (not imported — same module-isolation rationale).
 * Message insert + conversation advance is a single RPC
 * (`uazapi_persist_inbound_image_message`, migration 043) mirroring
 * `uazapi_persist_inbound_document_message`'s atomicity/dedup
 * guarantees, plus an explicit `p_account_id` re-check inside the RPC
 * itself (see the migration's comment for why).
 *
 * Never accepts or forwards UAZAPI's `URL`, `mediaKey`, `directPath`,
 * any WhatsApp crypto hash, or the raw base64 payload into a log
 * line — the decoded file buffer is held only as long as needed to
 * check its signature and upload it, then discarded.
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
import type { ParsedInboundImageMessage, SupportedImageMimeType } from './uazapi-webhook-image-parser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const BUCKET = 'whatsapp-attachments'

type ImageFormat = 'jpeg' | 'png' | 'webp'

const MIME_TO_FORMAT: Record<SupportedImageMimeType, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const FORMAT_TO_EXTENSION: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
}

/**
 * Real file-content signature check — the declared MIME type is never
 * trusted alone. JPEG: `FF D8 FF`. PNG: the full 8-byte PNG signature
 * `89 50 4E 47 0D 0A 1A 0A`. WebP: `RIFF` at bytes 0-3 and `WEBP` at
 * bytes 8-11 (the 4-byte chunk size in between is not checked).
 */
function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

export interface PersistInboundImageMessageArgs {
  db: SupabaseClient
  accountId: string
  /** Audit FK for inserts that require one — same convention as the text/document paths. */
  configOwnerUserId: string
  /** Already-decrypted UAZAPI instance token — decryption stays the caller's job. */
  instanceToken: string
  parsed: ParsedInboundImageMessage
}

export type PersistInboundImageOutcome =
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

/** Same classification buckets as the text/document paths — reads only `error.code`, never `.message`. */
function classifyDatabaseError(error: unknown): DatabaseErrorCode {
  const code = sqlStateOf(error)
  if (code === 'unknown_error') return 'unknown_database_error'
  if (code === 'PGRST202' || code === 'PGRST301') return 'rpc_not_found'
  if (code === '42501') return 'rpc_permission_denied'
  if (code.startsWith('23')) return 'constraint_violation'
  if (code === '22P02' || code === '42883' || code.startsWith('22')) return 'invalid_argument'
  return 'database_failed'
}

/** True for a Supabase Storage "object already exists" response — treated as a benign retry/race, never a hard failure. */
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

/** Strict base64 charset check, run BEFORE any size estimate or `Buffer.from` call — same rationale as the document path (rejects whitespace/data-URI-prefix gaps that would make the length-based size estimate wrong). */
function isValidBase64Charset(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function stripJidSuffix(value: string): string {
  const at = value.indexOf('@')
  return at >= 0 ? value.slice(0, at) : value
}

function normalizeCandidatePhone(raw: string): string | null {
  const digits = stripJidSuffix(raw).replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return digits
}

function extractPhone(parsed: ParsedInboundImageMessage): string | null {
  return normalizeCandidatePhone(parsed.sender) ?? normalizeCandidatePhone(parsed.chatId)
}

/**
 * Deterministic, multitenant, sanitized storage path — never the raw
 * `providerMessageId` or any provider-controlled string. Hashing
 * `providerMessageId` also makes a webhook redelivery of the SAME
 * message land on the exact same path instead of creating a new
 * object each retry. Extension is derived from the CONFIRMED decoded
 * format (never the caller-declared MIME type alone).
 */
function buildStoragePath(
  accountId: string,
  conversationId: string,
  providerMessageId: string,
  extension: string,
): string | null {
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(conversationId)) return null
  const hash = createHash('sha256').update(providerMessageId).digest('hex')
  return `${accountId}/${conversationId}/${hash}.${extension}`
}

/**
 * Finds or creates the contact + conversation, checks for a known
 * duplicate cheaply, downloads and validates the real file, uploads it
 * to the private bucket, then persists via RPC.
 *
 * Concurrency and orphan prevention: identical reasoning to
 * `persistInboundDocumentMessage` — two deliveries for the SAME
 * `providerMessageId` compute the same deterministic path; whichever
 * upload lands first "wins" the object, the RPC's
 * `ON CONFLICT (conversation_id, message_id) DO NOTHING` is the actual
 * source of truth for the message row. The best-effort Storage cleanup
 * below only ever runs when THIS execution's own upload call reported
 * success (`uploadedThisRun`), and even then only after re-checking
 * that no message row exists for this `(conversation_id, message_id)`
 * — an object this run didn't itself just create, or one a concurrent
 * execution may be about to finish persisting, is never deleted.
 */
export async function persistInboundImageMessage({
  db,
  accountId,
  configOwnerUserId,
  instanceToken,
  parsed,
}: PersistInboundImageMessageArgs): Promise<PersistInboundImageOutcome> {
  const phone = extractPhone(parsed)
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

  // Tenancy: re-verified explicitly even though `findOrCreateConversation`
  // already scopes by account_id, and even though the RPC re-checks this
  // too — same "derive tenancy from the resolved conversation row"
  // defense-in-depth as the document path.
  if (conversation.account_id !== accountId) {
    console.error(
      '[uazapi/webhook:image-persist] resolved conversation does not belong to the expected account',
    )
    return { outcome: 'error', code: 'conversation_failed' }
  }

  // Cheap known-duplicate short-circuit — correctness never depends on
  // this; the RPC's ON CONFLICT below is authoritative regardless.
  const { data: existingRow, error: existingError } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', parsed.providerMessageId)
    .maybeSingle()
  if (existingError) {
    console.error(
      '[uazapi/webhook:image-persist] known-duplicate check failed:',
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
      returnLink: false,
    })
  } catch (err) {
    if (err instanceof UazapiHttpError) {
      console.error('[uazapi/webhook:image-persist] download failed, status:', err.status)
    } else {
      console.error(
        '[uazapi/webhook:image-persist] download failed:',
        err instanceof Error ? err.name : 'unknown',
      )
    }
    return { outcome: 'error', code: 'download_failed' }
  }

  if (!downloadResult.base64Data) {
    // Same FASE 3.1 decision as the document path: never fall back to
    // fetching `fileUrl` server-side — fail closed instead.
    console.error('[uazapi/webhook:image-persist] download returned no base64Data')
    return { outcome: 'error', code: 'download_failed' }
  }

  if (!isValidBase64Charset(downloadResult.base64Data)) {
    return { outcome: 'error', code: 'validation_failed' }
  }

  // Pre-decode estimate, then the real allocated size is re-checked
  // post-decode below — same two-stage cap as the document path.
  const decodedSize = estimateBase64DecodedBytes(downloadResult.base64Data)
  if (decodedSize <= 0 || decodedSize > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) {
    return { outcome: 'error', code: 'validation_failed' }
  }

  let buffer: Buffer | undefined = Buffer.from(downloadResult.base64Data, 'base64')
  try {
    if (buffer.length > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) {
      return { outcome: 'error', code: 'validation_failed' }
    }

    const detectedFormat = detectImageFormat(buffer)
    if (!detectedFormat) {
      // Never trust the declared mimetype (or absence of a real
      // signature) alone.
      return { outcome: 'error', code: 'validation_failed' }
    }
    if (MIME_TO_FORMAT[parsed.mimeType] !== detectedFormat) {
      // Declared MIME type and real file signature disagree — reject.
      return { outcome: 'error', code: 'validation_failed' }
    }
    if (downloadResult.mimetype && downloadResult.mimetype !== parsed.mimeType) {
      return { outcome: 'error', code: 'validation_failed' }
    }

    const extension = FORMAT_TO_EXTENSION[detectedFormat]
    const path = buildStoragePath(accountId, conversation.id, parsed.providerMessageId, extension)
    if (!path) {
      console.error(
        '[uazapi/webhook:image-persist] refusing to build a storage path from a non-UUID account/conversation id',
      )
      return { outcome: 'error', code: 'validation_failed' }
    }

    let uploadedThisRun = false
    const { error: uploadError } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: parsed.mimeType,
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) {
      if (!isStorageAlreadyExistsError(uploadError)) {
        console.error('[uazapi/webhook:image-persist] upload failed')
        return { outcome: 'error', code: 'upload_failed' }
      }
      // Pre-existing object (retry/race) — never deleted by this run.
    } else {
      uploadedThisRun = true
    }

    // Sanitized metadata only — never URL/mediaKey/hashes/directPath/
    // base64/raw payload.
    const metadata: Record<string, unknown> = {
      captionPresent: Boolean(parsed.caption),
      decodedSize,
      format: detectedFormat,
    }
    if (parsed.width !== undefined) metadata.width = parsed.width
    if (parsed.height !== undefined) metadata.height = parsed.height

    const { data: rpcResult, error: rpcError } = await db.rpc(
      'uazapi_persist_inbound_image_message',
      {
        p_account_id: accountId,
        p_conversation_id: conversation.id,
        p_message_id: parsed.providerMessageId,
        p_content_text: parsed.caption ?? parsed.fileName,
        p_occurred_at: parsed.occurredAt,
        p_media_storage_path: path,
        p_media_file_name: parsed.fileName,
        p_media_mime_type: parsed.mimeType,
        p_media_file_size: decodedSize,
        p_media_metadata: metadata,
      },
    )

    if (rpcError) {
      console.error('[uazapi/webhook:image-persist] rpc failed:', classifyDatabaseError(rpcError))
      if (uploadedThisRun) {
        // Race guard: re-check before deleting — never delete an
        // object that a concurrent execution's now-successful RPC
        // call already claimed. See the docstring above for the full
        // reasoning (identical to the document path).
        const { data: raceCheck } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('message_id', parsed.providerMessageId)
          .maybeSingle()
        if (!raceCheck) {
          const { error: cleanupError } = await db.storage.from(BUCKET).remove([path])
          if (cleanupError) {
            console.error('[uazapi/webhook:image-persist] best-effort cleanup failed')
          }
        }
      }
      return { outcome: 'error', code: 'database_failed' }
    }

    if (rpcResult === 'persisted') return { outcome: 'persisted' }
    if (rpcResult === 'duplicate') return { outcome: 'duplicate' }

    console.error('[uazapi/webhook:image-persist] rpc returned an unexpected value')
    return { outcome: 'error', code: 'database_failed' }
  } finally {
    // Discard the decoded file content as soon as this function is
    // done with it — never held longer than necessary, never logged.
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
  console.error('[uazapi/webhook:image-persist] contact insert failed:', classifyDatabaseError(error))
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
      '[uazapi/webhook:image-persist] conversation lookup failed:',
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
    '[uazapi/webhook:image-persist] conversation insert failed:',
    classifyDatabaseError(createError),
  )
  return null
}
