/**
 * Persistence for a parsed inbound UAZAPI text message. Contact and
 * conversation find-or-create mirror the Meta webhook's shape
 * (`src/app/api/whatsapp/webhook/route.ts`) so both providers agree
 * on tenancy (`account_id`) and audit (`user_id` = the config owner)
 * conventions. The message insert + conversation advance is a single
 * RPC (`uazapi_persist_inbound_text_message`, migration 038) so both
 * happen in one atomic server-side transaction — see that migration
 * for the full design rationale.
 *
 * Scope for this stage: text only. No media, no automations/flows/AI,
 * no reply-to resolution — those are deliberately out of scope here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import type { ParsedInboundTextMessage } from './uazapi-webhook-parser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

export interface PersistInboundTextMessageArgs {
  db: SupabaseClient
  accountId: string
  /** Audit FK for inserts that require one — always the whatsapp_config owner, same convention as the Meta path. */
  configOwnerUserId: string
  parsed: ParsedInboundTextMessage
}

export type PersistInboundOutcome =
  | { outcome: 'persisted' }
  | { outcome: 'duplicate' }
  | { outcome: 'error'; code: 'contact_failed' | 'conversation_failed' | 'database_failed' }

/** Postgres SQLSTATE, when available — never the error message text. */
function sqlStateOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

/**
 * TEMPORARY diagnostic aid (etapa 8.2G) — buckets a raw Postgres/
 * PostgREST error code into one of a small, fixed set of safe labels
 * for logs. Reads only `error.code` (never `.message`, never the
 * request/response body) and returns one of six literals — nothing
 * else is ever logged from this function.
 */
type DatabaseErrorCode =
  | 'rpc_not_found'
  | 'rpc_permission_denied'
  | 'constraint_violation'
  | 'invalid_argument'
  | 'database_failed'
  | 'unknown_database_error'

function classifyDatabaseError(error: unknown): DatabaseErrorCode {
  const code = sqlStateOf(error)
  if (code === 'unknown_error') return 'unknown_database_error'

  // PostgREST-level routing errors — the RPC name/signature isn't (yet)
  // in PostgREST's schema cache. A very common cause right after a
  // migration is applied outside the normal deploy path: the schema
  // cache hasn't reloaded yet.
  if (code === 'PGRST202' || code === 'PGRST301') return 'rpc_not_found'

  // Postgres SQLSTATEs.
  if (code === '42501') return 'rpc_permission_denied'
  if (code.startsWith('23')) return 'constraint_violation' // class 23 = integrity_constraint_violation
  if (code === '22P02' || code === '42883' || code.startsWith('22')) return 'invalid_argument'

  return 'database_failed'
}

/**
 * Finds or creates the contact + conversation, then delegates the
 * message insert and conversation advance to a single RPC call so
 * they happen atomically. Distinguishes exactly three outcomes —
 * never collapses a real database failure into the same shape as a
 * legitimate duplicate, which is what let a failed persist silently
 * ack 200 to UAZAPI in the previous version of this module.
 */
export async function persistInboundTextMessage({
  db,
  accountId,
  configOwnerUserId,
  parsed,
}: PersistInboundTextMessageArgs): Promise<PersistInboundOutcome> {
  const contact = await findOrCreateContact(db, accountId, configOwnerUserId, parsed.phone, parsed.name)
  if (!contact) return { outcome: 'error', code: 'contact_failed' }

  const conversation = await findOrCreateConversation(db, accountId, configOwnerUserId, contact.id)
  if (!conversation) return { outcome: 'error', code: 'conversation_failed' }

  const { data, error } = await db.rpc('uazapi_persist_inbound_text_message', {
    p_conversation_id: conversation.id,
    p_message_id: parsed.externalMessageId,
    p_content_text: parsed.text,
    p_occurred_at: parsed.occurredAt,
  })

  if (error) {
    // Outward outcome.code stays the generic 'database_failed' (the
    // route only ever needs to know "retry or not"); the sanitized
    // classification below is diagnostic-only, log-side.
    console.error('[uazapi/webhook:persist] rpc failed:', classifyDatabaseError(error))
    return { outcome: 'error', code: 'database_failed' }
  }

  if (data === 'persisted') return { outcome: 'persisted' }
  if (data === 'duplicate') return { outcome: 'duplicate' }

  // Anything else (unexpected return shape) is treated conservatively
  // as a failure rather than silently assumed to be a success.
  console.error('[uazapi/webhook:persist] rpc returned an unexpected value')
  return { outcome: 'error', code: 'database_failed' }
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
    // Lost a race against a concurrent inbound delivery — re-resolve
    // the winner instead of dropping the message (mirrors the Meta path).
    return await findExistingContact(db, accountId, phone)
  }
  console.error('[uazapi/webhook:persist] contact insert failed:', classifyDatabaseError(error))
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
    console.error('[uazapi/webhook:persist] conversation lookup failed:', classifyDatabaseError(findError))
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
  console.error('[uazapi/webhook:persist] conversation insert failed:', classifyDatabaseError(createError))
  return null
}
