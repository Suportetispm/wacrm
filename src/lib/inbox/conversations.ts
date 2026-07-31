import type { Conversation, Contact, Tag } from "@/types";
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
