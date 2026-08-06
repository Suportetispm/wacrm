import type { SupabaseClient } from "@supabase/supabase-js";

export type MarkConversationReadResult =
  | { outcome: "marked_read" }
  | { outcome: "already_read" }
  | { outcome: "error"; error: unknown };

/**
 * Thin, testable wrapper around the `mark_conversation_read` RPC
 * (migration 044) — replaces the old `supabase.from('conversations')
 * .update({ unread_count: 0 })`, which relied purely on RLS
 * (`conversations_update` requires role >= 'agent') and silently
 * no-op'd for `viewer`-role callers with no error surfaced anywhere.
 *
 * Never throws — callers decide how to surface `outcome: "error"`
 * (toast, console, retry, ...).
 */
export async function markConversationRead(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<MarkConversationReadResult> {
  const { data, error } = await supabase.rpc("mark_conversation_read", {
    p_conversation_id: conversationId,
  });
  if (error) return { outcome: "error", error };
  if (data === "already_read") return { outcome: "already_read" };
  return { outcome: "marked_read" };
}
