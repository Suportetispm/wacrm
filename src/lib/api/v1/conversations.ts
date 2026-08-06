// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
// ============================================================

import type { Conversation, ConversationStatus, Message } from '@/types';

// Migration 045 (FASE 5C) ampliou o modelo interno de status de
// conversa de três valores (open/pending/closed) para cinco. O
// contrato público v1 (docs/public-api.md) continua documentando só
// os três valores originais — este shim traduz nos dois sentidos, para
// nenhum consumidor externo existente quebrar. Os dois estados novos
// ('in_progress' e 'waiting_customer') mapeiam para o antigo 'open'
// (ambos são "conversa ativa, não fechada" no contrato antigo);
// 'finalized' mapeia para o antigo 'closed' (estado terminal). Um
// possível v2 da API pode expor os cinco valores diretamente.
export type PublicConversationStatus = 'open' | 'pending' | 'closed';

const INTERNAL_TO_PUBLIC_STATUS: Record<ConversationStatus, PublicConversationStatus> = {
  pending: 'pending',
  in_progress: 'open',
  waiting_customer: 'open',
  closed: 'closed',
  finalized: 'closed',
};

/** Traduz um status interno (5 valores) para o status público v1 (3 valores). */
export function toPublicConversationStatus(status: ConversationStatus): PublicConversationStatus {
  return INTERNAL_TO_PUBLIC_STATUS[status];
}

const PUBLIC_TO_INTERNAL_STATUSES: Record<PublicConversationStatus, ConversationStatus[]> = {
  open: ['in_progress', 'waiting_customer'],
  pending: ['pending'],
  closed: ['closed', 'finalized'],
};

/**
 * Traduz um valor de filtro `?status=` recebido de um cliente v1 para
 * o(s) valor(es) interno(s) correspondente(s). Retorna `null` para
 * qualquer valor fora dos três documentados — o chamador decide o que
 * fazer com um filtro não reconhecido (hoje, repassar como está, que
 * preserva o comportamento de "nunca casa nenhuma linha" que a rota
 * já tinha para um valor inválido antes deste shim existir).
 */
export function fromPublicConversationStatusFilter(
  publicStatus: string,
): ConversationStatus[] | null {
  if (publicStatus === 'open' || publicStatus === 'pending' || publicStatus === 'closed') {
    return PUBLIC_TO_INTERNAL_STATUSES[publicStatus];
  }
  return null;
}

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: PublicConversationStatus;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 */
export function serializeConversation(conv: Conversation): ApiConversation {
  const c = conv.contact;
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: toPublicConversationStatus(conv.status),
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}
