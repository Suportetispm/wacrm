import type {
  ActiveConversationTicket,
  Conversation,
  ConversationStatus,
  Contact,
  Tag,
} from "@/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUniqueViolation } from "@/lib/contacts/dedupe";

/**
 * Conversation select that embeds the contact plus its tags (so the Inbox
 * can filter by contact tag without a second round-trip) and every ticket
 * for this conversation, narrowed down to `active_ticket` by
 * {@link normalizeConversation} — see migration 068's Etapa 2 gap fix.
 * `tickets(...)` embeds ALL of the conversation's tickets (closed history
 * included) rather than filtering server-side: the DB already guarantees
 * at most one row with status IN ('open','pending')
 * (`idx_tickets_one_active_per_conversation`, 040_tickets.sql), so picking
 * the active one client-side ({@link pickActiveTicket}) avoids touching
 * every call site's query chain (list, new-conversation modal, /api/v1)
 * just to add a per-embed filter — this is a left join, so a conversation
 * with no tickets at all still comes back, just with `tickets: []`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), tickets(id, status, assigned_agent_id, queue_id)";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact" | "active_ticket"> & {
  contact?: RawContact | null;
  tickets?: ActiveConversationTicket[] | null;
};

/**
 * Picks the conversation's active ticket (status IN ('open','pending'))
 * out of the raw, unfiltered `tickets` embed. Defensive against more than
 * one match (returns the first) even though the DB's partial unique index
 * should never allow it — a stale/racy read is safer to under-react to
 * than to throw on.
 */
export function pickActiveTicket(
  tickets: ActiveConversationTicket[] | null | undefined,
): ActiveConversationTicket | null {
  if (!tickets) return null;
  return (
    tickets.find((t) => t.status === "open" || t.status === "pending") ??
    null
  );
}

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`,
 * and the embedded `tickets(...)` join into `active_ticket`. Safe to call
 * on rows fetched with {@link CONVERSATION_SELECT}; a row with no contact
 * (e.g. a freshly-inserted conversation) passes through untouched, same
 * for one with no tickets at all.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  const { tickets, ...rest } = raw;
  const normalized: Conversation = {
    ...(rest as Omit<Conversation, "contact" | "active_ticket">),
    active_ticket: pickActiveTicket(tickets),
  };

  if (!rawContact) return normalized;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...normalized,
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
 * Re-reads one conversation's `active_ticket` after an Inbox ticket
 * action succeeds (068 Etapa 2, P1). The realtime `conversations`
 * UPDATE that follows a ticket RPC only carries the conversation's own
 * columns, so the embedded ticket would otherwise stay as it was when
 * the list loaded. Reuses {@link CONVERSATION_SELECT} +
 * {@link normalizeConversation} so this is the exact same RLS-scoped
 * view the list shows — a ticket the caller can no longer see comes
 * back `null`, and the 069 visibility check takes it from there.
 *
 * Returns `null` (not "no active ticket") when the read fails or the
 * row is gone, so callers keep what they had instead of guessing.
 */
export async function fetchConversationActiveTicket(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ activeTicket: ActiveConversationTicket | null } | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("Failed to refresh the conversation's active ticket:", error);
    return null;
  }
  if (!data) return null;

  return {
    activeTicket: normalizeConversation(data as RawConversation).active_ticket ?? null,
  };
}

/**
 * A fresher `active_ticket` for one conversation, fetched by
 * {@link fetchConversationActiveTicket} after a ticket action. `base`
 * is the `conversation.active_ticket` reference the override was taken
 * against — see {@link effectiveActiveTicket}.
 */
export interface ActiveTicketOverride {
  conversationId: string;
  base: ActiveConversationTicket | null;
  activeTicket: ActiveConversationTicket | null;
}

/**
 * The active ticket the Inbox should act on: the override when it
 * belongs to this conversation AND the conversation's own
 * `active_ticket` is still the same reference it was taken against,
 * otherwise the conversation's own value. Realtime merges and local
 * status/assignee patches spread the old object (same reference), so
 * the override survives them; a list reload re-normalizes every row
 * (new reference), so data fetched after the override wins over it.
 */
export function effectiveActiveTicket(
  conversation: Pick<Conversation, "id" | "active_ticket">,
  override: ActiveTicketOverride | null,
): ActiveConversationTicket | null {
  const own = conversation.active_ticket ?? null;
  if (
    override &&
    override.conversationId === conversation.id &&
    override.base === own
  ) {
    return override.activeTicket;
  }
  return own;
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

/**
 * Patches a single conversation's activity fields (preview text,
 * timestamp, unread count) by id. Every other conversation passes
 * through untouched. Pure — shared by the optimistic-send path and the
 * realtime message/conversation handlers so both converge on the same
 * field set instead of drifting.
 */
export function updateConversationPreview(
  conversations: Conversation[],
  conversationId: string,
  patch: Partial<
    Pick<Conversation, "last_message_text" | "last_message_at" | "unread_count">
  >,
): Conversation[] {
  return conversations.map((c) =>
    c.id === conversationId ? { ...c, ...patch } : c,
  );
}

/**
 * Moves the conversation matching `conversationId` to the front of the
 * list, preserving the relative order of every other conversation.
 * No-op (returns the same array reference) when the id isn't present or
 * is already first — cheap enough to call defensively from every
 * activity path (optimistic send, message INSERT, conversation UPDATE)
 * without worrying about triggering spurious re-renders.
 */
export function moveConversationToTop(
  conversations: Conversation[],
  conversationId: string,
): Conversation[] {
  const idx = conversations.findIndex((c) => c.id === conversationId);
  if (idx <= 0) return conversations;
  const target = conversations[idx];
  return [
    target,
    ...conversations.slice(0, idx),
    ...conversations.slice(idx + 1),
  ];
}

/**
 * Sorts by most-recent activity (`last_message_at` descending), a
 * conversation with no `last_message_at` (never messaged — e.g. just
 * created via "Nova conversa") sorting last, not first.
 *
 * Applied as a render-time guarantee in ConversationList, on top of
 * (not instead of) the incremental `moveConversationToTop` calls in
 * the realtime handlers: those keep `conversations` state correctly
 * ordered as activity happens, but the initial DB fetch
 * (`ORDER BY last_message_at DESC`) inherits Postgres's default NULLS
 * FIRST for DESC — a never-messaged conversation would otherwise sort
 * ahead of every conversation with real (even old) activity on first
 * load. Sorting again here, defensively, at the one place the list is
 * actually rendered means the displayed order is always correct
 * regardless of what produced `conversations` — the initial fetch,
 * `moveConversationToTop`, or any future code path that touches it.
 *
 * `Array.prototype.sort` is a stable sort per spec (ES2019+), so two
 * conversations with the exact same `last_message_at` keep whatever
 * relative order they already had — never reshuffled arbitrarily.
 */
export function sortConversationsByRecentActivity(
  conversations: Conversation[],
): Conversation[] {
  const timeOf = (c: Conversation) =>
    c.last_message_at ? new Date(c.last_message_at).getTime() : -Infinity;
  return [...conversations].sort((a, b) => timeOf(b) - timeOf(a));
}

/**
 * Whether an optimistic-send rollback (reverting the preview fields
 * `updateConversationPreview` set) is still safe to apply: only when the
 * conversation's `last_message_at` still matches what the optimistic
 * bump set it to. If it doesn't match, genuinely new activity (another
 * outbound send, or an inbound message) landed for this conversation
 * since the optimistic bump — the rollback must be skipped so it
 * doesn't clobber that real data with stale pre-send values.
 */
export function shouldRollbackConversationPreview(
  conversations: Conversation[],
  conversationId: string,
  optimisticAt: string,
): boolean {
  const current = conversations.find((c) => c.id === conversationId);
  return !!current && current.last_message_at === optimisticAt;
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
