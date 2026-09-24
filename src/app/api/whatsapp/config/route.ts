import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  AccountDisabledError,
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { loadPrimaryWhatsAppConfigRow } from '@/lib/whatsapp/active-config'
import {
  checkNewConnectionAllowed,
  MULTI_CONNECTION_DISABLED_CODE,
  MULTI_CONNECTION_DISABLED_MESSAGE,
} from '@/lib/whatsapp/connection-gate'

const CONNECTION_HAS_HISTORY_MESSAGE =
  'This WhatsApp connection has conversation history and cannot be removed. To replace its credentials, enter them again and save.'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    // ETAPA 077A: filtra provider='meta' explicitamente — esta rota só
    // sabe testar credenciais Meta (verifyPhoneNumber abaixo), então
    // nunca deveria resolver uma linha UAZAPI mesmo quando a conta
    // tiver mais de uma conexão. order+limit(1) garante no máximo 1
    // linha antes do maybeSingle(), independente de quantas linhas
    // existam — nunca mais quebra com PGRST116 (ver
    // WACRM_AUDITORIA_WHATSAPP_CONFIG_MULTICONNECTION.md). Hoje
    // (UNIQUE(account_id) ainda ativa) o resultado é idêntico ao
    // anterior.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    // Saving Meta config runs verifyPhoneNumber/registerPhoneNumber/
    // subscribeWabaToApp directly against Graph API before the
    // `whatsapp_config_insert`/`whatsapp_config_update` RLS policies
    // (both require 'admin') ever run on the persistence step below.
    // Without this upfront check, any authenticated member could use
    // this route as an oracle to test an arbitrary access_token against
    // Meta, or burn a real phone number's registration, with no way to
    // persist the result locally. Same fix as /templates/submit
    // (requireRole).
    const { supabase, userId, accountId } = await requireRole('admin')

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    //
    // ETAPA 077A note: this `.maybeSingle()` stays safe even after
    // `whatsapp_config_account_id_key` (UNIQUE(account_id)) is
    // eventually removed — `phone_number_id` has its OWN, separate
    // UNIQUE constraint (`whatsapp_config_phone_number_id_key`,
    // migration 013), unrelated to account_id's. A non-null
    // `phone_number_id` can never match more than one row in the
    // whole table regardless of how many rows any single account has,
    // so this query was never actually at risk — confirmed here
    // rather than "fixed" by mistake.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Look up any pre-existing Meta row for this account so we know
    // whether this number is already registered with Meta — if so we
    // can skip /register when the user didn't provide a PIN this time
    // around. ETAPA 077A: filters provider='meta' (this route only
    // ever writes Meta rows) + order+limit(1) so it never breaks once
    // an account can have more than one connection — see the GET
    // handler above for the same reasoning.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id')
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    // ETAPA 078-0: sem linha Meta, este save vira um INSERT — uma
    // conexão nova, possivelmente paralela a uma UAZAPI já existente.
    // Gate de multiconexão antes de qualquer chamada à Meta (verify/
    // register/subscribe). Editar a linha Meta existente (branch de
    // UPDATE abaixo) nunca passa por aqui.
    if (!existing) {
      const gate = await checkNewConnectionAllowed(supabaseAdmin(), accountId)
      if (!gate.allowed) {
        if (gate.reason === 'lookup_failed') {
          return NextResponse.json(
            { error: 'Failed to validate configuration' },
            { status: 500 }
          )
        }
        return NextResponse.json(
          { error: MULTI_CONNECTION_DISABLED_MESSAGE, code: MULTI_CONNECTION_DISABLED_CODE },
          { status: 409 }
        )
      }
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      // ETAPA 077A: scoped to the exact row we just resolved (`id`),
      // not `account_id` — updating by account_id alone would rewrite
      // every connection the account has (including unrelated UAZAPI
      // rows) with Meta-shaped data the moment more than one row can
      // exist. Same observable result today (only one row per
      // account while the UNIQUE constraint stands).
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017), `user_id` is the audit column identifying
      // which member of the account saved the config.
      //
      // ETAPA 077A note (residual risk, not fixed in this pass — the
      // race-condition fix requested for this etapa was scoped to
      // src/app/api/uazapi/instance/route.ts, not this file): today
      // `whatsapp_config_account_id_key` (UNIQUE(account_id)) still
      // makes a concurrent double-insert here fail loudly (23505) —
      // this INSERT has no explicit try/catch for that code today, so
      // a genuine race would surface as an unhandled 500, same as
      // before this etapa. Once that UNIQUE is removed (migration
      // 077), this "SELECT existing, else INSERT" pattern stops being
      // race-safe by accident — needs the same treatment as the
      // UAZAPI instance route before 077 ships, tracked separately.
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: userId,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError ||
      error instanceof AccountDisabledError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PATCH /api/whatsapp/config
 *
 * Narrow endpoint (051) for setting/clearing this connection's
 * default queue — where a future automatic protocol/ticket would
 * route to (not implemented yet; see 051's migration header).
 * Deliberately separate from POST: POST re-verifies Meta credentials
 * and re-runs webhook registration on every save, which is wrong (and
 * provider-specific — a UAZAPI-connected account never touches those
 * fields at all) for a change that's only "which queue this
 * connection routes to." admin-gated via `requireRole` (unlike POST,
 * which relies on `whatsapp_config_update`'s RLS policy already
 * requiring admin — this route surfaces that as a clean 403 instead
 * of a silent RLS no-op).
 */
export async function PATCH(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || !('default_queue_id' in body)) {
    return NextResponse.json({ error: 'default_queue_id is required' }, { status: 400 })
  }

  let defaultQueueId: string | null
  if (body.default_queue_id === null) {
    defaultQueueId = null
  } else if (typeof body.default_queue_id === 'string' && body.default_queue_id) {
    // Clean 400 instead of the DB trigger's raw exception text —
    // confirm the target is a real queue in THIS account before
    // attempting the update. The trigger
    // (whatsapp_config_validate_default_queue_account, migration 051)
    // is still the authoritative check.
    const { data: queue } = await ctx.supabase
      .from('queues')
      .select('id')
      .eq('id', body.default_queue_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!queue) {
      return NextResponse.json(
        { error: 'default_queue_id must reference a queue in this account' },
        { status: 400 },
      )
    }
    defaultQueueId = body.default_queue_id
  } else {
    return NextResponse.json({ error: 'default_queue_id must be a string or null' }, { status: 400 })
  }

  // ETAPA 077A: resolve a conexão primária primeiro e escreve pelo
  // `id` exato — atualizar por `account_id` sozinho aplicaria o mesmo
  // default_queue_id a TODAS as conexões da conta assim que houver
  // mais de uma (Meta e UAZAPI juntas). Sem conceito explícito de
  // "conexão padrão" ainda, resolve para a mesma linha que
  // `loadActiveWhatsAppConfig` usaria — mesmo resultado observável de
  // hoje (uma linha só).
  const primaryRow = await loadPrimaryWhatsAppConfigRow(ctx.supabase, ctx.accountId, 'id')
  if (!primaryRow) {
    return NextResponse.json({ error: 'No WhatsApp configuration saved yet' }, { status: 404 })
  }

  const { data, error } = await ctx.supabase
    .from('whatsapp_config')
    .update({ default_queue_id: defaultQueueId })
    .eq('id', primaryRow.id)
    .select('id, default_queue_id')
    .maybeSingle()

  if (error) {
    console.error('Error updating whatsapp_config.default_queue_id:', error)
    return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'No WhatsApp configuration saved yet' }, { status: 404 })
  }

  return NextResponse.json({ default_queue_id: data.default_queue_id })
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // ETAPA 077A: resolve a conexão primária e apaga só ela pelo `id`
    // — deletar por `account_id` sozinho apagaria TODAS as conexões
    // da conta assim que houver mais de uma. Mesmo resultado
    // observável de hoje (uma linha só).
    const primaryRow = await loadPrimaryWhatsAppConfigRow(supabase, accountId, 'id')
    if (!primaryRow) {
      return NextResponse.json({ success: true })
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', primaryRow.id)

    if (deleteError) {
      // ETAPA 078A-PREP: a partir da 078A, conversations referenciam a
      // conexão (FK NO ACTION) — uma conexão com histórico não pode
      // ser apagada. Reset não é necessário para recuperar um token
      // corrompido: reinserir as credenciais e salvar (POST) atualiza a
      // MESMA linha in-place.
      if (deleteError.code === '23503') {
        return NextResponse.json(
          {
            error: CONNECTION_HAS_HISTORY_MESSAGE,
            code: 'connection_has_history',
          },
          { status: 409 }
        )
      }
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
