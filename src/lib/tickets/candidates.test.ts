import { describe, expect, it } from 'vitest'

import { eligibleTransferAgentCandidates } from './candidates'
import type { AccountMember } from '@/types'

function member(overrides: Partial<AccountMember> & { user_id: string }): AccountMember {
  return {
    full_name: 'Someone',
    email: 'someone@acme.com',
    avatar_url: null,
    role: 'agent',
    joined_at: 'now',
    is_active: true,
    ...overrides,
  }
}

describe('eligibleTransferAgentCandidates', () => {
  it('excludes owner and viewer roles', () => {
    const members = [
      member({ user_id: 'owner-1', role: 'owner' }),
      member({ user_id: 'viewer-1', role: 'viewer' }),
      member({ user_id: 'agent-1', role: 'agent' }),
    ]
    const result = eligibleTransferAgentCandidates(members, null, null)
    expect(result.map((c) => c.user_id)).toEqual(['agent-1'])
  })

  it('excludes inactive members', () => {
    const members = [
      member({ user_id: 'agent-1', is_active: false }),
      member({ user_id: 'agent-2', is_active: true }),
    ]
    const result = eligibleTransferAgentCandidates(members, null, null)
    expect(result.map((c) => c.user_id)).toEqual(['agent-2'])
  })

  it('excludes the current assignee', () => {
    const members = [member({ user_id: 'agent-1' }), member({ user_id: 'agent-2' })]
    const result = eligibleTransferAgentCandidates(members, null, 'agent-1')
    expect(result.map((c) => c.user_id)).toEqual(['agent-2'])
  })

  it('when the ticket has no queue (queueMemberIds=null), any active admin/agent qualifies', () => {
    const members = [
      member({ user_id: 'agent-1', role: 'agent' }),
      member({ user_id: 'admin-1', role: 'admin' }),
    ]
    const result = eligibleTransferAgentCandidates(members, null, null)
    expect(result.map((c) => c.user_id).sort()).toEqual(['admin-1', 'agent-1'])
  })

  it('when the ticket has a queue, an agent must be an active member of it — admins are exempt', () => {
    const members = [
      member({ user_id: 'agent-in-queue', role: 'agent' }),
      member({ user_id: 'agent-not-in-queue', role: 'agent' }),
      member({ user_id: 'admin-not-in-queue', role: 'admin' }),
    ]
    const result = eligibleTransferAgentCandidates(members, ['agent-in-queue'], null)
    expect(result.map((c) => c.user_id).sort()).toEqual(['admin-not-in-queue', 'agent-in-queue'])
  })

  it('an empty queueMemberIds array (queue exists but has no active members) still allows admins through', () => {
    const members = [
      member({ user_id: 'agent-1', role: 'agent' }),
      member({ user_id: 'admin-1', role: 'admin' }),
    ]
    const result = eligibleTransferAgentCandidates(members, [], null)
    expect(result.map((c) => c.user_id)).toEqual(['admin-1'])
  })

  it('labels fall back from full_name to email to user_id', () => {
    const members = [
      member({ user_id: 'a', full_name: 'Jane', email: 'jane@acme.com' }),
      member({ user_id: 'b', full_name: '', email: 'noname@acme.com' }),
      member({ user_id: 'c', full_name: '', email: null }),
    ]
    const result = eligibleTransferAgentCandidates(members, null, null)
    expect(result.find((c) => c.user_id === 'a')?.label).toBe('Jane')
    expect(result.find((c) => c.user_id === 'b')?.label).toBe('noname@acme.com')
    expect(result.find((c) => c.user_id === 'c')?.label).toBe('c')
  })
})
