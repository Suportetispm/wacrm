import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { syncContactWhatsAppAvatar } from '@/lib/whatsapp/contact-avatar-sync'
import {
  AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST,
  avatarVersionFromPath,
  type AvatarSyncResponse,
  type AvatarSyncResult,
  type AvatarSyncResultStatus,
} from '@/lib/inbox/contact-avatar-sync-shared'

// POST /api/contacts/avatar-sync — background sync of WhatsApp profile
// pictures for conversations the caller can already see in the Inbox,
// without waiting for the contact to send a new message.
//
//   - Conversations are read with the caller's RLS-scoped client AND an
//     explicit account_id filter: an id from another account (or one the
//     caller's Inbox visibility hides) is simply "not_found".
//   - The connection is ALWAYS the conversation's own whatsapp_config_id
//     (same account, provider uazapi). NULL → skipped; never the primary
//     connection, never a guess.
//   - `number` for /chat/avatar is the contact's stored phone (digits
//     only — no JID is built), in 'background' mode: an empty answer
//     never removes an existing photo.
//   - Sequential, at most AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST ids;
//     a UAZAPI 429 stops the rest of the batch and answers throttled.
//   - The response carries an opaque version (content-hash prefix) per
//     contact, never the storage path.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function badRequest() {
  return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
}

function parseConversationIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = (body as { conversationIds?: unknown }).conversationIds
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST) return null
  if (!raw.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null
  return Array.from(new Set(raw as string[]))
}

interface ConversationRow {
  id: string
  account_id: string
  whatsapp_config_id: string | null
  contact: { id: string; account_id: string; phone: string | null } | null
}

interface ConfigRow {
  id: string
  account_id: string
  provider: string | null
  uazapi_instance_token: string | null
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }
  const accountId = ctx.accountId

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest()
  }
  const conversationIds = parseConversationIds(body)
  if (!conversationIds) return badRequest()

  const limit = await checkRateLimit(`avatar-sync:${accountId}`, RATE_LIMITS.avatarSyncAccount)
  if (!limit.success) {
    const throttled: AvatarSyncResponse = { throttled: true, results: [] }
    return NextResponse.json(throttled, { status: 429 })
  }

  const { data: convData, error: convError } = await ctx.supabase
    .from('conversations')
    .select('id, account_id, whatsapp_config_id, contact:contacts(id, account_id, phone)')
    .in('id', conversationIds)
    .eq('account_id', accountId)
  if (convError) {
    console.error('[contacts/avatar-sync] conversation lookup failed')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  const conversations = new Map<string, ConversationRow>()
  for (const row of (convData ?? []) as unknown as ConversationRow[]) {
    if (row.account_id === accountId) conversations.set(row.id, row)
  }

  const admin = supabaseAdmin()

  const configIds = Array.from(
    new Set(
      Array.from(conversations.values())
        .map((c) => c.whatsapp_config_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  )
  const configs = new Map<string, ConfigRow>()
  if (configIds.length > 0) {
    const { data: configData, error: configError } = await admin
      .from('whatsapp_config')
      .select('id, account_id, provider, uazapi_instance_token')
      .in('id', configIds)
      .eq('account_id', accountId)
    if (configError) {
      console.error('[contacts/avatar-sync] connection lookup failed')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    for (const row of (configData ?? []) as ConfigRow[]) {
      if (row.account_id === accountId) configs.set(row.id, row)
    }
  }

  const statuses = new Map<string, { contactId: string | null; status: AvatarSyncResultStatus }>()
  const outcomeByContact = new Map<string, AvatarSyncResultStatus>()
  let throttled = false

  for (const conversationId of conversationIds) {
    const conversation = conversations.get(conversationId)
    if (!conversation) {
      statuses.set(conversationId, { contactId: null, status: 'not_found' })
      continue
    }
    const contact = conversation.contact && conversation.contact.account_id === accountId ? conversation.contact : null
    if (!contact) {
      statuses.set(conversationId, { contactId: null, status: 'skipped_no_contact' })
      continue
    }
    if (throttled) {
      statuses.set(conversationId, { contactId: contact.id, status: 'not_processed' })
      continue
    }
    const config = conversation.whatsapp_config_id ? configs.get(conversation.whatsapp_config_id) : undefined
    if (!conversation.whatsapp_config_id || !config) {
      statuses.set(conversationId, { contactId: contact.id, status: 'skipped_no_connection' })
      continue
    }
    if (config.provider !== 'uazapi') {
      statuses.set(conversationId, { contactId: contact.id, status: 'skipped_provider' })
      continue
    }

    // Same contact in two conversations of this batch: query once.
    let status = outcomeByContact.get(contact.id)
    if (!status) {
      const encryptedToken = config.uazapi_instance_token
      status = await syncContactWhatsAppAvatar({
        db: admin,
        accountId,
        contactId: contact.id,
        chatId: (contact.phone ?? '').replace(/\D/g, ''),
        mode: 'background',
        getInstanceToken: async () => {
          if (!encryptedToken) throw new Error('token_unavailable')
          return decrypt(encryptedToken)
        },
      })
      outcomeByContact.set(contact.id, status)
    }
    statuses.set(conversationId, { contactId: contact.id, status })
    if (status === 'throttled') throttled = true
  }

  // Current avatar state of every contact in the batch — so even a
  // 'fresh' (no query) answer lets the UI pick up a photo the webhook
  // stored after the page loaded.
  const contactIds = Array.from(
    new Set(Array.from(statuses.values()).map((s) => s.contactId).filter((id): id is string => typeof id === 'string')),
  )
  const avatars = new Map<string, AvatarSyncResult['avatar']>()
  if (contactIds.length > 0) {
    const { data: contactData, error: contactError } = await admin
      .from('contacts')
      .select('id, whatsapp_avatar_path, whatsapp_avatar_checked_at')
      .in('id', contactIds)
      .eq('account_id', accountId)
    if (contactError) {
      console.error('[contacts/avatar-sync] contact state lookup failed')
    } else {
      for (const row of (contactData ?? []) as {
        id: string
        whatsapp_avatar_path: string | null
        whatsapp_avatar_checked_at: string | null
      }[]) {
        avatars.set(row.id, {
          version: avatarVersionFromPath(row.whatsapp_avatar_path),
          checkedAt: row.whatsapp_avatar_checked_at ?? null,
        })
      }
    }
  }

  const response: AvatarSyncResponse = {
    throttled,
    results: conversationIds.map((conversationId) => {
      const { contactId, status } = statuses.get(conversationId)!
      return {
        conversationId,
        contactId,
        status,
        avatar: contactId ? (avatars.get(contactId) ?? null) : null,
      }
    }),
  }
  return NextResponse.json(response, { status: 200 })
}
