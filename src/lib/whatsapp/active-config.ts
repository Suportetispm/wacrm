// ============================================================
// Resolves an account's *active* WhatsApp connection — whichever
// provider it's on — into a ready-to-use, decrypted shape.
//
// Every send path (send-message.ts, broadcast-core.ts,
// automations/meta-send.ts, flows/meta-send.ts) used to read
// `whatsapp_config` and decrypt `access_token` inline, hard-wired to
// Meta. This is the one place that now knows how to do that for
// either provider, so call sites just branch on `.provider` once
// they have the result.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from './encryption'

export type ActiveWhatsAppConfig =
  | { provider: 'meta'; phoneNumberId: string; accessToken: string; configId: string }
  | { provider: 'uazapi'; instanceToken: string; configId: string }

/**
 * Load and decrypt the account's active WhatsApp config. Returns
 * `null` when there's no row, or the row is missing the fields its
 * own `provider` requires (e.g. a UAZAPI row saved before the QR
 * scan completed a token). Self-heals legacy CBC ciphertexts to GCM
 * in the background, same as the inline logic each call site used
 * to have.
 */
export async function loadActiveWhatsAppConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<ActiveWhatsAppConfig | null> {
  const { data: row, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()

  if (error || !row) return null

  if (row.provider !== 'meta' && row.provider !== 'uazapi') {
    throw new Error('whatsapp_config has an unrecognized provider value.')
  }

  if (row.provider === 'uazapi') {
    if (!row.uazapi_instance_token) return null
    const instanceToken = decrypt(row.uazapi_instance_token)

    if (isLegacyFormat(row.uazapi_instance_token)) {
      void db
        .from('whatsapp_config')
        .update({ uazapi_instance_token: encrypt(instanceToken) })
        .eq('id', row.id)
        .then(({ error: upgradeError }: { error: { message: string } | null }) => {
          if (upgradeError) {
            console.warn(
              '[active-config] uazapi_instance_token GCM upgrade failed:',
              upgradeError.message,
            )
          }
        })
    }

    return { provider: 'uazapi', instanceToken, configId: row.id }
  }

  // provider === 'meta'
  if (!row.access_token || !row.phone_number_id) return null
  const accessToken = decrypt(row.access_token)

  if (isLegacyFormat(row.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', row.id)
      .then(({ error: upgradeError }: { error: { message: string } | null }) => {
        if (upgradeError) {
          console.warn(
            '[active-config] access_token GCM upgrade failed:',
            upgradeError.message,
          )
        }
      })
  }

  return {
    provider: 'meta',
    phoneNumberId: row.phone_number_id,
    accessToken,
    configId: row.id,
  }
}

/** Thrown by send call sites when a UAZAPI account attempts a
 *  Meta-only operation (templates) that has no UAZAPI equivalent. */
export class ProviderUnsupportedError extends Error {
  constructor(feature: string) {
    super(
      `${feature} isn't supported on UAZAPI connections — use text/media, or connect via Meta Cloud API.`,
    )
    this.name = 'ProviderUnsupportedError'
  }
}
