import type { Conversation, ConversationStatus, Contact, Tag } from "@/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUniqueViolation } from "@/lib/contacts/dedupe";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

/**
 * Reconciles a freshly-fetched conversation list (a resync — tab
 * visibility regain, WS reconnect, manual refresh button) against the
 * conversation the user currently has open.
 *
 * Why this is needed: `mark_conversation_read` (migration 044) is
 * fire-and-forget from the UI's perspective — there's always a window
 * between the user opening a conversation and the server-side
 * `unread_count` actually reaching 0. If a resync's full refetch lands
 * inside that window, the raw DB row it returns can still carry the
 * pre-reset (nonzero) count; passing it straight to UI state would
 * reintroduce a badge the user just cleared. `handleConversationEvent`
 * (the realtime UPDATE handler in the inbox page) already avoids this
 * exact problem for individual events by forcing `unread_count: 0` for
 * whichever conversation is active; this function applies the same
 * rule to a full-list resync.
 *
 * This ONLY ever touches the active conversation's row, and only its
 * `unread_count` — every other conversation's row (and every other
 * field of the active one) passes through exactly as fetched. It does
 * NOT hide a genuinely new message: the message itself arrives via the
 * separate messages realtime channel regardless of this list's badge,
 * and the server-side `unread_count` still gets corrected by another
 * `mark_conversation_read` call the next time the reset effect re-fires
 * (it watches `activeConversation.unread_count`, a different piece of
 * state this function never touches) — this function only ever
 * suppresses the cosmetic badge for a conversation the user is already
 * looking at, never the underlying data.
 */
export function reconcileLoadedConversations(
  loaded: Conversation[],
  activeConversationId: string | null | undefined,
): Conversation[] {
  if (!activeConversationId) return loaded;
  return loaded.map((c) =>
    c.id === activeConversationId ? { ...c, unread_count: 0 } : c,
  );
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

export interface InboxFilters {
  /** `"all"` é um no-op — qualquer outro valor restringe pelo status exato. */
  status: ConversationStatus | "all";
  /** Quando true, só conversas com unread_count > 0 passam. */
  unreadOnly: boolean;
  /** `null` = sem filtro; `"unassigned"` = sem responsável; qualquer outro valor = id do responsável exato. */
  assigneeId: string | "unassigned" | null;
}

/**
 * FASE 5C — filtros combinados da inbox (aba de status + não lidas +
 * responsável), independentes dos filtros de contato
 * ({@link matchesContactFilters}) e da busca textual (que continuam
 * vivendo só no componente, por operarem sobre `contact`/texto livre
 * em vez de campos simples da própria conversa).
 */
export function matchesInboxFilters(
  conversation: Conversation,
  filters: InboxFilters,
): boolean {
  if (filters.status !== "all" && conversation.status !== filters.status) {
    return false;
  }
  if (filters.unreadOnly && conversation.unread_count <= 0) {
    return false;
  }
  if (filters.assigneeId === "unassigned") {
    if (conversation.assigned_agent_id) return false;
  } else if (filters.assigneeId) {
    if (conversation.assigned_agent_id !== filters.assigneeId) return false;
  }
  return true;
}

/**
 * Contagem por status entre TODAS as conversas carregadas — usada nas
 * abas da inbox. Deliberadamente não aplica busca/etiquetas/empresa/
 * responsável/não-lidas: contagem de aba reflete quantas conversas
 * existem em cada status, não quantas sobram depois de filtros
 * adicionais (mesmo padrão de contador de pasta de e-mail). Tenancy já
 * é respeitada porque `conversations` só contém linhas que a RLS
 * liberou para o usuário atual.
 */
export function countConversationsByStatus(
  conversations: Conversation[],
): Record<ConversationStatus, number> {
  const counts: Record<ConversationStatus, number> = {
    pending: 0,
    in_progress: 0,
    waiting_customer: 0,
    closed: 0,
    finalized: 0,
  };
  for (const c of conversations) {
    counts[c.status] += 1;
  }
  return counts;
}

/**
 * Find the account's existing conversation for a contact, or create one.
 * Mirrors the private helper in `/api/whatsapp/send` (only reachable
 * there by actually sending a message) so the "New conversation" modal
 * can reuse the exact same find-or-create semantics without sending
 * anything. Relies on RLS (`conversations_insert` requires agent+) —
 * no service role, no new route.
 */
export async function findOrCreateConversationForContact(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<{ id: string; created: boolean } | null> {
  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existing) return { id: existing.id, created: false };

  const { data: created, error } = await db
    .from("conversations")
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
    .select("id")
    .single();

  if (!error) return { id: created.id, created: true };

  // Race: another insert (or the inbound webhook) created the
  // conversation between our SELECT and this INSERT. Backed by the
  // UNIQUE index `idx_conversations_account_contact`
  // (migration 036_conversation_contact_dedup.sql) — re-query and
  // hand back the winner instead of failing the whole flow.
  if (isUniqueViolation(error)) {
    const { data: winner } = await db
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle();
    if (winner) return { id: winner.id, created: false };
  }

  // Unrecoverable — some other error (permission, network, etc.).
  return null;
}
