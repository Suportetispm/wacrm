import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { createInstance } from '@/lib/whatsapp/uazapi-api'

const GENERIC_UAZAPI_ERROR = 'Unable to reach UAZAPI. Please try again.'

/**
 * POST /api/uazapi/instance
 *
 * Provisions a UAZAPI instance for the caller's account (idempotent —
 * a second call is a no-op if one already exists) and switches
 * `provider` to 'uazapi'. Any Meta credentials already on the row are
 * left untouched (not nulled) so DELETE can restore them later.
 */
export async function POST() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, userId, accountId, account } = ctx

  const { data: existing, error: existingError } = await supabase
    .from('whatsapp_config')
    .select('id, provider, uazapi_instance_id, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (existingError) {
    console.error('[uazapi/instance] error checking existing config:', existingError.message)
    return NextResponse.json({ error: 'Failed to check existing configuration' }, { status: 500 })
  }

  if (existing?.provider === 'uazapi') {
    if (existing.uazapi_instance_token) {
      // Idempotent — a fully-provisioned instance already exists.
      return NextResponse.json({ success: true, provider: 'uazapi', already_exists: true })
    }
    // provider says uazapi but there's no instance token — a broken
    // partial state from an earlier failed attempt. Don't silently
    // create a second instance on top of it.
    console.error(
      '[uazapi/instance] inconsistent config: provider=uazapi with no instance token',
      { accountId },
    )
    return NextResponse.json(
      {
        error:
          'Existing UAZAPI configuration is incomplete (missing instance token). Reset the connection before retrying.',
      },
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

  // Only the UAZAPI-specific fields + provider are written. Any Meta
  // credentials already on this row are deliberately left untouched
  // — dormant, not deleted — so DELETE can restore them later.
  const row = {
    provider: 'uazapi' as const,
    uazapi_instance_id: created.instanceId,
    uazapi_instance_token: encryptedToken,
    uazapi_instance_name: (account.name || accountId).slice(0, 60),
    status: 'disconnected' as const,
    connected_at: null,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    // existing.provider === 'meta' here (the uazapi branch above
    // already returned). Guarded by id + account_id + the provider we
    // actually read, so a concurrent change is detected instead of
    // silently overwritten.
    const { data: updated, error: updateError } = await supabase
      .from('whatsapp_config')
      .update(row)
      .eq('id', existing.id)
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .select('id')
    if (updateError) {
      console.error('[uazapi/instance] update failed:', updateError.message)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'Configuration changed concurrently. Please retry.' },
        { status: 409 },
      )
    }
  } else {
    const { error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({ account_id: accountId, user_id: userId, ...row })
    if (insertError) {
      // 23505 = Postgres unique_violation — another request created
      // the row (UNIQUE(account_id)) between our check and this insert.
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'Configuration was created concurrently. Please retry.' },
          { status: 409 },
        )
      }
      console.error('[uazapi/instance] insert failed:', insertError.message)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true, provider: 'uazapi' })
}

/**
 * DELETE /api/uazapi/instance
 *
 * Disconnects UAZAPI from the caller's account. Never touches
 * messages/contacts/conversations — only this one config row.
 *
 *   - If the row still has a usable Meta phone_number_id + a
 *     decryptable access_token (dormant since POST /instance never
 *     deletes them), switches `provider` back to 'meta' and clears
 *     only the UAZAPI fields — waba_id, if present, is preserved
 *     (never touched). This is the ONLY place a provider switch back
 *     to Meta happens — never as an automatic fallback during sends.
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

  const { data: existing, error: existingError } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (existingError) {
    console.error('[uazapi/instance] error checking existing config:', existingError.message)
    return NextResponse.json({ error: 'Failed to check existing configuration' }, { status: 500 })
  }
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
      .eq('account_id', accountId)
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

  const { data: deleted, error: deleteError } = await supabase
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .select('id')

  if (deleteError) {
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
