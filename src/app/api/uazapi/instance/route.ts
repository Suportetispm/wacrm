import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { createInstance } from '@/lib/whatsapp/uazapi-api'
import { loadPrimaryWhatsAppConfigRow } from '@/lib/whatsapp/active-config'
import { supabaseAdmin } from '@/lib/account/admin-client'
import {
  checkNewConnectionAllowed,
  MULTI_CONNECTION_DISABLED_CODE,
  MULTI_CONNECTION_DISABLED_MESSAGE,
} from '@/lib/whatsapp/connection-gate'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

/**
 * POST /api/uazapi/instance
 *
 * ETAPA 077B — MULTICONEXÃO: provisions a brand-new, independent
 * UAZAPI instance for the caller's account and inserts it as its own
 * `whatsapp_config` row. Every call creates a new connection — there
 * is no "the account's instance" to look up, no idempotent no-op, and
 * no upgrade-in-place of an existing row (Meta or otherwise). An
 * account can hold any number of UAZAPI rows plus, independently, a
 * Meta row — none of them are ever mutated by this handler.
 *
 * Rows created by the OLD (pre-077B) version of this route may still
 * carry dormant Meta credentials on a `provider: 'uazapi'` row (from
 * when POST used to upgrade an existing Meta row in place) — DELETE
 * below still knows how to restore those for such legacy rows. Rows
 * created by THIS version never do, because this version never
 * writes to a row it didn't just insert.
 *
 * Race condition / 23505 handling: this insert only ever sets
 * account_id, user_id, provider, uazapi_instance_id/token/name,
 * status and connected_at — it never sets phone_number_id (stays
 * NULL, and NULLs never collide under a UNIQUE index). Whether a
 * 23505 here can happen, and what it means, depends entirely on which
 * constraints are active on `whatsapp_config` at the time this runs:
 *
 *   - Before migration 077 (`whatsapp_config_account_id_key`,
 *     UNIQUE(account_id), migration 017, still active): a second
 *     connection for the same account fails at the database with
 *     23505 on that specific constraint — this is the ONLY unique
 *     constraint this insert can hit pre-077.
 *   - After migration 077 drops that constraint: this insert has no
 *     remaining unique column it sets a real value for, so a 23505
 *     here becomes anomalous (in practice: at most an astronomically
 *     unlikely PK collision on the generated `id`, or a future
 *     constraint added later on a column this insert touches) — it
 *     can no longer be assumed to mean "this account already has a
 *     connection".
 *
 * The handler below inspects the actual constraint name reported by
 * Postgres instead of assuming which one fired, so the message stays
 * honest on both sides of the 077 migration without needing a code
 * change the day 077 ships. No advisory lock or RPC is needed either
 * way (see the 077B report, Fase 2/4): two concurrent POSTs each
 * provision their own independent external UAZAPI instance and insert
 * their own independent PK row; nothing is shared between them for
 * Postgres to serialize.
 */
export async function POST() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, userId, accountId, account } = ctx

  // ETAPA 078-0: gate de multiconexão ANTES de qualquer chamada
  // externa — bloquear depois do /instance/init deixaria uma instância
  // órfã na UAZAPI. Ver src/lib/whatsapp/connection-gate.ts.
  const gate = await checkNewConnectionAllowed(supabaseAdmin(), accountId)
  if (!gate.allowed) {
    if (gate.reason === 'lookup_failed') {
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    return NextResponse.json(
      { error: MULTI_CONNECTION_DISABLED_MESSAGE, code: MULTI_CONNECTION_DISABLED_CODE },
      { status: 409 },
    )
  }

  let created
  try {
    created = await createInstance({ name: (account.name || accountId).slice(0, 60) })
  } catch (err) {
    console.error(
      '[uazapi/instance] createInstance failed:',
      err instanceof Error ? err.name : 'UnknownError',
    )
    return NextResponse.json({ error: GENERIC_UAZAPI_ERROR }, { status: 502 })
  }

  let encryptedToken: string
  try {
    encryptedToken = encrypt(created.instanceToken)
  } catch (err) {
    console.error(
      '[uazapi/instance] token encryption failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json(
      {
        error:
          'Failed to encrypt instance token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
      },
      { status: 500 },
    )
  }

  const { data: inserted, error: insertError } = await supabase
    .from('whatsapp_config')
    .insert({
      account_id: accountId,
      user_id: userId,
      provider: 'uazapi' as const,
      uazapi_instance_id: created.instanceId,
      uazapi_instance_token: encryptedToken,
      uazapi_instance_name: (account.name || accountId).slice(0, 60),
      status: 'disconnected' as const,
      connected_at: null,
    })
    .select('id')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      // Inspect which constraint actually fired instead of assuming —
      // see the function doc comment above for why this can no longer
      // be assumed to be whatsapp_config_account_id_key once 077
      // drops it.
      const message = insertError.message || ''
      if (message.includes('whatsapp_config_account_id_key')) {
        // Pre-077 only: retrying will fail identically for as long as
        // this constraint is in place, regardless of whether this was
        // a genuine concurrent create or simply "this account already
        // has a connection". Both collapse to the same honest state.
        console.warn(
          '[uazapi/instance] insert blocked by whatsapp_config_account_id_key (multi-connection not yet enabled)',
          { accountId },
        )
        return NextResponse.json(
          {
            error:
              'This account already has a WhatsApp connection. Support for multiple simultaneous connections is being rolled out for this account type.',
          },
          { status: 409 },
        )
      }
      if (message.includes('whatsapp_config_phone_number_id_key')) {
        console.warn('[uazapi/instance] insert blocked by phone_number_id conflict', { accountId })
        return NextResponse.json(
          { error: 'A configuration for this WhatsApp number already exists.' },
          { status: 409 },
        )
      }
      // Unknown/unexpected unique violation — do not guess a cause.
      console.error('[uazapi/instance] insert hit unexpected unique violation:', message, {
        accountId,
      })
      return NextResponse.json(
        { error: 'Failed to save configuration due to a conflict. Please try again.' },
        { status: 409 },
      )
    }
    console.error('[uazapi/instance] insert failed:', insertError.message)
    return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
  }

  return NextResponse.json({ success: true, provider: 'uazapi', configId: inserted.id })
}

/**
 * DELETE /api/uazapi/instance
 *
 * Disconnects UAZAPI from the caller's account. Never touches
 * messages/contacts/conversations — only this one config row.
 *
 * ETAPA 077B — KNOWN SCOPE LIMIT: this still targets the account's
 * deterministic *primary* row (`loadPrimaryWhatsAppConfigRow` — prefer
 * `status='connected'`, else oldest), the same as GET /status and
 * POST /connect. It has no way to target one specific connection
 * among several — that needs an id-scoped route/UI, deliberately out
 * of scope here (see the 077B report). POST above can now create
 * more than one UAZAPI row per account; this DELETE cannot yet
 * disconnect any but the primary one.
 *
 *   - If the resolved row still has a usable Meta phone_number_id + a
 *     decryptable access_token, switches `provider` back to 'meta'
 *     and clears only the UAZAPI fields — waba_id, if present, is
 *     preserved (never touched). This is the ONLY place a provider
 *     switch back to Meta happens — never as an automatic fallback
 *     during sends. LEGACY PATH: only rows created by the pre-077B
 *     version of POST (which used to upgrade an existing Meta row in
 *     place) ever carry dormant Meta fields on a `provider: 'uazapi'`
 *     row — a row created by the current POST never does, since POST
 *     no longer writes to any row but the one it just inserted. Kept
 *     for backward compatibility with rows that already exist.
 *   - Otherwise, deletes the row entirely (mirrors the existing
 *     DELETE /api/whatsapp/config reset behavior).
 *
 * Does NOT call any UAZAPI endpoint to delete the remote instance —
 * no such contract has been confirmed yet. The instance may still
 * exist on the UAZAPI server; every response says so explicitly.
 */
export async function DELETE() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId } = ctx

  // ETAPA 077A: resolves the account's deterministic primary row instead
  // of a plain .eq('account_id', ...).maybeSingle() — the latter throws
  // PGRST116 as soon as the account has more than one row.
  const existing = await loadPrimaryWhatsAppConfigRow(supabase, accountId)
  if (!existing) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration found for this account' },
      { status: 404 },
    )
  }
  if (existing.provider !== 'uazapi') {
    return NextResponse.json(
      { error: 'The active connection for this account is not UAZAPI' },
      { status: 400 },
    )
  }

  const REMOTE_INSTANCE_NOTICE =
    "The UAZAPI instance itself was not deleted on the UAZAPI server — only this app's local configuration was updated. It may still exist under your UAZAPI account."

  // Complete Meta credentials = phone_number_id + a decryptable
  // access_token. waba_id is NOT required — legacy Meta rows may lack
  // it, and we never want to lose a usable legacy config just
  // because of that. waba_id, if present, is preserved automatically
  // — it's simply never included in the update payload below.
  let hasMetaCreds = Boolean(existing.phone_number_id && existing.access_token)
  if (hasMetaCreds) {
    try {
      decrypt(existing.access_token)
    } catch {
      hasMetaCreds = false
    }
  }

  if (hasMetaCreds) {
    // ETAPA 077A: scoped to `existing.id` (the exact row resolved above)
    // instead of `account_id` + `provider='uazapi'` — the old filter
    // would restore EVERY uazapi row on the account back to meta at
    // once, once there's more than one.
    const { data: updated, error: updateError } = await supabase
      .from('whatsapp_config')
      .update({
        provider: 'meta',
        uazapi_instance_id: null,
        uazapi_instance_token: null,
        uazapi_instance_name: null,
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('provider', 'uazapi')
      .select('id')

    if (updateError) {
      console.error('[uazapi/instance] restore-to-meta update failed:', updateError.message)
      return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'Configuration changed concurrently. Please retry.' },
        { status: 409 },
      )
    }

    return NextResponse.json({
      success: true,
      provider: 'meta',
      restored_meta: true,
      note: REMOTE_INSTANCE_NOTICE,
    })
  }

  // ETAPA 077A: scoped to `existing.id` instead of `account_id` +
  // `provider='uazapi'` — the old filter would delete EVERY uazapi row
  // on the account at once, once there's more than one.
  const { data: deleted, error: deleteError } = await supabase
    .from('whatsapp_config')
    .delete()
    .eq('id', existing.id)
    .eq('provider', 'uazapi')
    .select('id')

  if (deleteError) {
    // ETAPA 078A-PREP: com a FK NO ACTION da 078A, uma conexão com
    // conversations não pode ser apagada. Recuperar uma instância
    // morta é POST /api/uazapi/instance/recreate (in-place).
    if (deleteError.code === '23503') {
      return NextResponse.json(
        {
          error:
            'This WhatsApp connection has conversation history and cannot be removed. Use "Recreate instance" to replace a broken instance.',
          code: 'connection_has_history',
        },
        { status: 409 },
      )
    }
    console.error('[uazapi/instance] delete failed:', deleteError.message)
    return NextResponse.json({ error: 'Failed to remove configuration' }, { status: 500 })
  }
  if (!deleted || deleted.length === 0) {
    return NextResponse.json(
      { error: 'Configuration changed concurrently. Please retry.' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: true,
    provider: null,
    restored_meta: false,
    note: REMOTE_INSTANCE_NOTICE,
  })
}
