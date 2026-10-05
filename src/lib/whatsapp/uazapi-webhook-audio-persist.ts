/**
 * Persistence for a parsed inbound UAZAPI audio / voice-note message.
 *
 * Mirrors `uazapi-webhook-image-persist.ts`'s structure, guarantees and
 * concurrency reasoning: same private `whatsapp-attachments` bucket
 * (migration 084 widens its `allowed_mime_types` with `audio/mpeg`),
 * same deterministic per-account/per-conversation storage path, same
 * download → validate → upload → RPC pipeline, same orphan-cleanup
 * race guard.
 *
 * One deliberate difference: the file comes from UAZAPI's `fileURL`
 * (`POST /message/download` with `generate_mp3: true`,
 * `return_base64: false`, `transcribe: false`), downloaded immediately
 * because that URL has limited retention — see
 * `uazapi-media-file-fetch.ts` for the guards on that fetch. The
 * stored file is always MP3, validated by its real signature.
 *
 * Inbound audio is NOT dispatched to Flows (Flows' inbound media model
 * has no `audio` type), so unlike the image path there is no post-RPC
 * routing re-read here.
 *
 * Contact/conversation find-or-create is a self-contained duplicate of
 * the image path's private helpers (not imported — same
 * module-isolation rationale as every other `uazapi-webhook-*-persist`).
 *
 * Never logs or persists UAZAPI's `URL`/`fileURL`, `mediaKey`,
 * `directPath`, any WhatsApp crypto hash, phone, name, or file bytes.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  downloadMessageMedia,
  UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES,
  UazapiHttpError,
} from './uazapi-api'
import { fetchUazapiMediaFile, isMp3Buffer, UazapiFileFetchError } from './uazapi-media-file-fetch'
import { resolveCanonicalPhone } from './uazapi-webhook-identity'
import { adoptInboundConnectionForExistingConversation } from './inbound-conversation-connection'
import type { ParsedInboundAudioMessage } from './uazapi-webhook-audio-parser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const BUCKET = 'whatsapp-attachments'
const STORED_MIME_TYPE = 'audio/mpeg'
const STORED_FILE_NAME = 'audio.mp3'
/** Message body + conversation preview — same `[<type>]` shape the outbound path uses for captionless media (send-message.ts). */
const PREVIEW_TEXT = '[audio]'

/** MIME types UAZAPI may declare for a `generate_mp3: true` download. Anything else is refused. */
const DECLARED_MP3_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3'])

export interface PersistInboundAudioMessageArgs {
  db: SupabaseClient
  accountId: string
  /** Audit FK for inserts that require one — same convention as the other paths. */
  configOwnerUserId: string
  /** Already-decrypted UAZAPI instance token — decryption stays the caller's job. */
  instanceToken: string
  /** ETAPA 078B: always the row the route resolved from instanceId + HMAC, never anything from the payload. */
  whatsappConfigId: string
  parsed: ParsedInboundAudioMessage
}

export type PersistInboundAudioOutcome =
  | { outcome: 'persisted' | 'duplicate'; contactId: string; conversationId: string }
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

function sqlStateOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

/** Same classification buckets as the other paths — reads only `error.code`, never `.message`. */
function classifyDatabaseError(error: unknown): string {
  const code = sqlStateOf(error)
  if (code === 'unknown_error') return 'unknown_database_error'
  if (code === 'PGRST202' || code === 'PGRST301') return 'rpc_not_found'
  if (code === '42501') return 'rpc_permission_denied'
  if (code.startsWith('23')) return 'constraint_violation'
  if (code === '22P02' || code === '42883' || code.startsWith('22')) return 'invalid_argument'
  return 'database_failed'
}

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function extractPhone(parsed: ParsedInboundAudioMessage): string | null {
  return resolveCanonicalPhone([
    parsed.senderPn,
    parsed.sender,
    parsed.chatPhone,
    parsed.chatId,
    parsed.chatWaChatid,
  ]).phone
}

/** Same deterministic, sanitized path as the image path: `{account}/{conversation}/{sha256(providerMessageId)}.mp3`. */
function buildStoragePath(accountId: string, conversationId: string, providerMessageId: string): string | null {
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(conversationId)) return null
  const hash = createHash('sha256').update(providerMessageId).digest('hex')
  return `${accountId}/${conversationId}/${hash}.mp3`
}

/**
 * Finds or creates the contact + conversation, checks for a known
 * duplicate cheaply, asks UAZAPI for an MP3 `fileURL`, downloads and
 * validates it, uploads it to the private bucket, then persists via
 * RPC. Concurrency/orphan handling is identical to the image path:
 * the RPC's `ON CONFLICT (conversation_id, message_id) DO NOTHING` is
 * authoritative; cleanup only removes an object THIS run uploaded,
 * and only after re-checking that no message row claimed it.
 */
export async function persistInboundAudioMessage({
  db,
  accountId,
  configOwnerUserId,
  instanceToken,
  whatsappConfigId,
  parsed,
}: PersistInboundAudioMessageArgs): Promise<PersistInboundAudioOutcome> {
  const phone = extractPhone(parsed)
  if (!phone) return { outcome: 'error', code: 'contact_failed' }

  const contact = await findOrCreateContact(db, accountId, configOwnerUserId, phone, parsed.senderName ?? phone)
  if (!contact) return { outcome: 'error', code: 'contact_failed' }

  const conversation = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contact.id,
    whatsappConfigId,
  )
  if (!conversation) return { outcome: 'error', code: 'conversation_failed' }

  if (conversation.account_id !== accountId) {
    console.error('[uazapi/webhook:audio-persist] resolved conversation does not belong to the expected account')
    return { outcome: 'error', code: 'conversation_failed' }
  }

  // Cheap known-duplicate short-circuit — the RPC's ON CONFLICT stays
  // authoritative. Skips the UAZAPI download entirely on a redelivery.
  const { data: existingRow, error: existingError } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', parsed.providerMessageId)
    .maybeSingle()
  if (existingError) {
    console.error(
      '[uazapi/webhook:audio-persist] known-duplicate check failed:',
      classifyDatabaseError(existingError),
    )
  } else if (existingRow) {
    return { outcome: 'duplicate', contactId: contact.id as string, conversationId: conversation.id as string }
  }

  let fileUrl: string
  try {
    const downloadResult = await downloadMessageMedia({
      instanceToken,
      id: parsed.providerDownloadId,
      generateMp3: true,
      returnBase64: false,
      transcribe: false,
    })
    if (!downloadResult.fileUrl) {
      console.error('[uazapi/webhook:audio-persist] download returned no fileURL')
      return { outcome: 'error', code: 'download_failed' }
    }
    if (downloadResult.mimetype) {
      const declared = downloadResult.mimetype.split(';')[0].trim().toLowerCase()
      if (!DECLARED_MP3_MIME_TYPES.has(declared)) {
        return { outcome: 'error', code: 'validation_failed' }
      }
    }
    fileUrl = downloadResult.fileUrl
  } catch (err) {
    if (err instanceof UazapiHttpError) {
      console.error('[uazapi/webhook:audio-persist] download failed, status:', err.status)
    } else {
      console.error('[uazapi/webhook:audio-persist] download failed:', err instanceof Error ? err.name : 'unknown')
    }
    return { outcome: 'error', code: 'download_failed' }
  }

  let buffer: Buffer | undefined
  try {
    try {
      const fetched = await fetchUazapiMediaFile({
        fileUrl,
        maxBytes: UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES,
      })
      buffer = fetched.buffer
    } catch (err) {
      const code = err instanceof UazapiFileFetchError ? err.code : 'unknown'
      console.error('[uazapi/webhook:audio-persist] file fetch failed:', code)
      return {
        outcome: 'error',
        code: code === 'content_type_refused' || code === 'too_large' || code === 'empty' || code === 'url_not_allowed'
          ? 'validation_failed'
          : 'download_failed',
      }
    }

    const fileSize = buffer.length
    if (fileSize <= 0 || fileSize > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES) {
      return { outcome: 'error', code: 'validation_failed' }
    }
    if (!isMp3Buffer(buffer)) {
      // Never trust the declared MIME type — an HTML/JSON body or any
      // non-MP3 bytes are refused here.
      return { outcome: 'error', code: 'validation_failed' }
    }

    const path = buildStoragePath(accountId, conversation.id, parsed.providerMessageId)
    if (!path) {
      console.error(
        '[uazapi/webhook:audio-persist] refusing to build a storage path from a non-UUID account/conversation id',
      )
      return { outcome: 'error', code: 'validation_failed' }
    }

    let uploadedThisRun = false
    const { error: uploadError } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: STORED_MIME_TYPE,
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) {
      if (!isStorageAlreadyExistsError(uploadError)) {
        console.error('[uazapi/webhook:audio-persist] upload failed')
        return { outcome: 'error', code: 'upload_failed' }
      }
      // Pre-existing object (retry/race) — never deleted by this run.
    } else {
      uploadedThisRun = true
    }

    // Sanitized metadata only — never URL/mediaKey/hashes/directPath/waveform.
    const metadata: Record<string, unknown> = {
      format: 'mp3',
      decodedSize: fileSize,
      voiceNote: parsed.isVoiceNote,
      sourceMimeType: parsed.sourceMimeType,
    }
    if (parsed.durationSeconds !== undefined) metadata.durationSeconds = parsed.durationSeconds

    const { data: rpcResult, error: rpcError } = await db.rpc('uazapi_persist_inbound_audio_message', {
      p_account_id: accountId,
      p_conversation_id: conversation.id,
      p_message_id: parsed.providerMessageId,
      p_content_text: PREVIEW_TEXT,
      p_occurred_at: parsed.occurredAt,
      p_media_storage_path: path,
      p_media_file_name: STORED_FILE_NAME,
      p_media_mime_type: STORED_MIME_TYPE,
      p_media_file_size: fileSize,
      p_media_metadata: metadata,
    })

    if (rpcError) {
      console.error('[uazapi/webhook:audio-persist] rpc failed:', classifyDatabaseError(rpcError))
      if (uploadedThisRun) {
        const { data: raceCheck } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('message_id', parsed.providerMessageId)
          .maybeSingle()
        if (!raceCheck) {
          const { error: cleanupError } = await db.storage.from(BUCKET).remove([path])
          if (cleanupError) {
            console.error('[uazapi/webhook:audio-persist] best-effort cleanup failed')
          }
        }
      }
      return { outcome: 'error', code: 'database_failed' }
    }

    if (rpcResult === 'persisted' || rpcResult === 'duplicate') {
      return { outcome: rpcResult, contactId: contact.id as string, conversationId: conversation.id as string }
    }

    console.error('[uazapi/webhook:audio-persist] rpc returned an unexpected value')
    return { outcome: 'error', code: 'database_failed' }
  } finally {
    // Discard the file content as soon as this function is done with it.
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
  console.error('[uazapi/webhook:audio-persist] contact insert failed:', classifyDatabaseError(error))
  return null
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  whatsappConfigId: string,
): Promise<Row | null> {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[uazapi/webhook:audio-persist] conversation lookup failed:', classifyDatabaseError(findError))
    return null
  }
  if (existingRows && existingRows.length > 0) {
    return adoptInboundConnectionForExistingConversation(db, {
      conversation: existingRows[0],
      accountId,
      whatsappConfigId,
    })
  }

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
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
    if (raced && raced.length > 0) {
      return adoptInboundConnectionForExistingConversation(db, {
        conversation: raced[0],
        accountId,
        whatsappConfigId,
      })
    }
  }
  console.error('[uazapi/webhook:audio-persist] conversation insert failed:', classifyDatabaseError(createError))
  return null
}
