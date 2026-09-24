import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// ETAPA 078B — inbound grava a conexão da conversa.
//
// Os 4 find-or-create de conversation do inbound (UAZAPI texto/
// imagem/documento e Meta) já recebem a whatsapp_config resolvida
// internamente (UAZAPI: instanceId + HMAC; Meta: phone_number_id) e
// passam a gravar `whatsapp_config_id` no INSERT de uma conversation
// nova. Este módulo cuida do outro caso: a conversation JÁ EXISTE.
//
// A identidade ainda é (account_id, contact_id) —
// idx_conversations_account_contact, 036. Então aqui NUNCA se cria uma
// segunda conversation, e as regras são:
//
//   - vínculo não-NULL: devolvido como está. Nunca sobrescrito. Se
//     apontar para outra conexão, só loga — até a 078D um contato tem
//     uma conversa só por account, e trocar o vínculo mudaria o número
//     pelo qual ela responde (078C).
//   - vínculo NULL (legado, ou criado por um caller que ainda não sabe
//     a conexão): adota a conexão do inbound SOMENTE se a account tem
//     exatamente 1 whatsapp_config. Nesse caso a config do inbound —
//     que pertence à account, resolvida internamente — é
//     necessariamente essa única config: mesmo critério determinístico
//     do backfill da 078A. Com >1 conexões fica NULL: não há como
//     saber, sem histórico por mensagem, a qual número a conversa
//     pertence.
//
// Nunca derruba o inbound: qualquer erro aqui é logado e a conversa é
// devolvida inalterada — a mensagem segue sendo persistida.
// ============================================================

export interface InboundConversationRow {
  id: string
  whatsapp_config_id?: string | null
  [key: string]: unknown
}

export async function adoptInboundConnectionForExistingConversation<T extends InboundConversationRow>(
  db: SupabaseClient,
  args: { conversation: T; accountId: string; whatsappConfigId: string },
): Promise<T> {
  const { conversation, accountId, whatsappConfigId } = args

  try {
    if (conversation.whatsapp_config_id) {
      if (conversation.whatsapp_config_id !== whatsappConfigId) {
        console.warn(
          '[inbound-connection] existing conversation is linked to a different connection — link kept unchanged',
        )
      }
      return conversation
    }

    const { count, error: countError } = await db
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)

    if (countError || count === null) {
      console.error('[inbound-connection] connection count failed — legacy conversation left unlinked')
      return conversation
    }
    if (count !== 1) {
      console.warn('[inbound-connection] account has', count, 'connections — legacy conversation left unlinked')
      return conversation
    }

    const { data: updated, error: updateError } = await db
      .from('conversations')
      .update({ whatsapp_config_id: whatsappConfigId })
      .eq('id', conversation.id)
      .eq('account_id', accountId)
      .is('whatsapp_config_id', null)
      .select('whatsapp_config_id')

    if (updateError) {
      console.error('[inbound-connection] legacy adoption update failed:', updateError.code ?? 'unknown_error')
      return conversation
    }
    if (!updated || updated.length === 0) {
      // Someone else linked it between our read and this update — the
      // `IS NULL` guard kept us from overwriting. Keep what we read.
      return conversation
    }
    return { ...conversation, whatsapp_config_id: whatsappConfigId }
  } catch (err) {
    console.error(
      '[inbound-connection] unexpected error — legacy conversation left unlinked:',
      err instanceof Error ? err.name : 'UnknownError',
    )
    return conversation
  }
}
