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
//
// ETAPA 077A — preparação de código para multiconexão (ver
// WACRM_AUDITORIA_WHATSAPP_CONFIG_MULTICONNECTION.md): `whatsapp_
// config.account_id` ainda tem `UNIQUE(account_id)` no banco (migration
// 017) — hoje existe SEMPRE exatamente 0 ou 1 linha por conta. Esta
// função foi reescrita para nunca usar `.single()`/`.maybeSingle()`,
// de propósito, para já ser segura no dia em que essa UNIQUE for
// removida (migration 077, ainda não criada), sem precisar de uma
// segunda rodada de mudança neste arquivo.
//
// SELEÇÃO DETERMINÍSTICA TEMPORÁRIA (documentada, não inventa coluna
// nova): entre as linhas de uma conta, prefere a que tem
// `status = 'connected'`; se nenhuma estiver conectada, cai para a
// mais antiga (`created_at` ascendente) — mesmo efeito observável de
// hoje (com 1 linha só, qualquer critério devolve essa mesma linha).
// Este critério é propositalmente mínimo e será substituído quando a
// conta ganhar um conceito explícito de "conexão padrão" (ex.:
// `conversations.whatsapp_config_id` resolvendo a conexão de origem
// de cada conversa, ou um campo de default explícito em
// `whatsapp_config` — nenhum dos dois existe ainda, nenhum dos dois é
// criado nesta etapa).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from './encryption'

/**
 * Shape returned by `loadPrimaryWhatsAppConfigRow` — the fields the
 * selection rule itself needs are typed; everything else a caller
 * `select()`s comes through via the index signature, same permissive
 * style already used for the Supabase client generics in this file.
 */
export interface WhatsAppConfigRowLike {
  id: string
  account_id: string
  status: string
  created_at: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/**
 * Fetches every `whatsapp_config` row for an account and returns the
 * one, deterministic "primary" row — never `.single()`/`.maybeSingle()`
 * (see module header). Shared by every read-only call site that used
 * to assume "at most one row per account" (Settings status checks,
 * templates, react, media, broadcast, the public v1 API, UAZAPI admin
 * routes, and the client-side Settings/Inbox/Dashboard badges) so the
 * same rule lives in exactly one place instead of being re-derived
 * per call site.
 *
 * `columns` mirrors `select()`'s argument — pass the same projection
 * the call site used to pass to `.select(...)`, or omit for `'*'`.
 */
export async function loadPrimaryWhatsAppConfigRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
  columns = '*',
): Promise<WhatsAppConfigRowLike | null> {
  const { data: rows, error } = await db
    .from('whatsapp_config')
    .select(columns)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })

  if (error || !rows || rows.length === 0) return null

  // `columns` is a plain `string`, not a literal type, so supabase-js
  // can't statically type the row shape here (it falls back to a
  // GenericStringError marker type) — same as every other dynamic
  // `.select(someVariable)` call site in this codebase.
  const typedRows = rows as unknown as WhatsAppConfigRowLike[]
  return typedRows.find((r) => r.status === 'connected') ?? typedRows[0]
}

export type ActiveWhatsAppConfig =
  | { provider: 'meta'; phoneNumberId: string; accessToken: string; configId: string }
  | { provider: 'uazapi'; instanceToken: string; configId: string; uazapiInstanceId: string | null }

/**
 * Load and decrypt the account's active WhatsApp config. Returns
 * `null` when there's no row, or the row is missing the fields its
 * own `provider` requires (e.g. a UAZAPI row saved before the QR
 * scan completed a token). Self-heals legacy CBC ciphertexts to GCM
 * in the background, same as the inline logic each call site used
 * to have.
 *
 * Never uses `.single()`/`.maybeSingle()` — see module header for why
 * and for the deterministic selection rule applied when more than one
 * row exists for the account.
 */
export async function loadActiveWhatsAppConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<ActiveWhatsAppConfig | null> {
  const row = await loadPrimaryWhatsAppConfigRow(db, accountId)
  if (!row) return null

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

    return {
      provider: 'uazapi',
      instanceToken,
      configId: row.id,
      uazapiInstanceId: row.uazapi_instance_id ?? null,
    }
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
