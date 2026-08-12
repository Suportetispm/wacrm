import type { AccountRole } from "@/lib/auth/roles";
import type { Conversation } from "@/types";

/**
 * Pure decision rules for the Inbox status automation (post-6E.5,
 * pre-ticket-integration): a customer message always reopens a
 * conversation to 'pending', an agent opening a 'pending' conversation
 * claims it, and an 'in_progress' conversation with no agent reply for
 * this many minutes falls back to 'pending'.
 *
 * These functions never touch the database and never know about
 * tickets — the "does this conversation already have a ticket?" guard
 * lives in status-automation.ts, one level up, because answering it
 * requires a DB round trip (ticketed_conversation_ids(), migration 050).
 * Conversations with a ticket must never reach these rules with intent
 * to write — tickets.* RPCs (migration 049) own their status instead.
 */

export const PENDING_REVERT_MINUTES = 10;

export interface LastMessageInfo {
  sender_type: string;
  created_at: string;
}

/**
 * Should an 'in_progress' conversation fall back to 'pending' because
 * the customer's last message went unanswered for too long?
 *
 * Deliberately NOT "10 minutes without any activity" — only the
 * customer-unanswered case reverts. If the most recent message is from
 * an agent (or a bot auto-reply), the conversation is considered
 * answered and never auto-reverts on time alone; only 'in_progress'
 * conversations are eligible (pending/waiting_customer/closed/
 * finalized never go through this path).
 */
export function shouldRevertToPending(
  conversation: Pick<Conversation, "status">,
  lastMessage: LastMessageInfo | null,
  now: Date,
): boolean {
  if (conversation.status !== "in_progress") return false;
  if (!lastMessage || lastMessage.sender_type !== "customer") return false;

  const elapsedMs = now.getTime() - new Date(lastMessage.created_at).getTime();
  return elapsedMs >= PENDING_REVERT_MINUTES * 60_000;
}

/**
 * Should opening this conversation attempt the pending → in_progress
 * (+ claim-if-unassigned) transition at all?
 *
 * Only an 'agent' caller ever triggers it — admin/owner opening a
 * pending conversation just views it, per product decision: an
 * admin/owner auto-claiming would take a conversation out of the
 * pending queue without anyone actually working it.
 */
export function isOpenTransitionEligible(
  conversation: Pick<Conversation, "status">,
  accountRole: AccountRole | null,
): boolean {
  return accountRole === "agent" && conversation.status === "pending";
}
