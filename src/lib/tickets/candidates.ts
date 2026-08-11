// ============================================================
// Pure helper for the "Transferir atendente" dialog's candidate
// list. Mirrors transfer_ticket_agent()'s own eligibility rule
// (supabase/migrations/049_ticket_operations.sql) as a client-side
// filter for what to OFFER in the picker — the RPC remains the real
// authority regardless of what this shows (a stale/wrong candidate
// list just produces a clean 22023/42501 from the API, never a
// security gap).
// ============================================================

import type { AccountMember } from '@/types'

export interface TransferAgentCandidate {
  user_id: string
  label: string
  role: 'admin' | 'agent'
}

/**
 * @param members         GET /api/account/members result for the account.
 * @param queueMemberIds  Active queue_members.user_id list for the
 *                        ticket's CURRENT queue, or `null` when the
 *                        ticket has no queue (queue_id === null) —
 *                        in that case any active admin/agent
 *                        qualifies, matching the RPC's own
 *                        `IF v_target_role = 'agent' AND
 *                        v_ticket.queue_id IS NOT NULL THEN …` guard.
 * @param currentAssigneeId  Excluded from the list — transferring to
 *                        the current assignee is now a rejected no-op
 *                        (see 049's revision).
 */
export function eligibleTransferAgentCandidates(
  members: AccountMember[],
  queueMemberIds: string[] | null,
  currentAssigneeId: string | null,
): TransferAgentCandidate[] {
  const queueMemberSet = queueMemberIds ? new Set(queueMemberIds) : null

  return members
    .filter((m): m is AccountMember & { role: 'admin' | 'agent' } => m.role === 'admin' || m.role === 'agent')
    .filter((m) => m.is_active)
    .filter((m) => m.user_id !== currentAssigneeId)
    .filter((m) => m.role === 'admin' || !queueMemberSet || queueMemberSet.has(m.user_id))
    .map((m) => ({
      user_id: m.user_id,
      label: m.full_name || m.email || m.user_id,
      role: m.role,
    }))
}
