import { describe, it, expect } from 'vitest';
import type { Conversation, ConversationStatus, Message } from '@/types';
import {
  fromPublicConversationStatusFilter,
  serializeConversation,
  serializeMessage,
  toPublicConversationStatus,
} from './conversations';

function conv(status: ConversationStatus) {
  return {
    id: 'conv1',
    user_id: 'internal-user',
    account_id: 'internal-acct',
    contact_id: 'c1',
    status,
    last_message_text: 'hi',
    last_message_at: '2026-01-01T00:00:00Z',
    unread_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    contact: {
      id: 'c1',
      phone: '+1',
      name: 'Jane',
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
    },
  } as unknown as Conversation;
}

describe('serializeConversation', () => {
  it('projects public fields + nested contact/tags and drops internals', () => {
    const out = serializeConversation(conv('in_progress'));
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('account_id');
    expect(out.contact?.tags).toEqual([{ id: 't1', name: 'vip', color: '#fff' }]);
    expect(out.unread_count).toBe(2);
  });

  it('migration 045 shim: maps the internal 5-value status onto the public 3-value contract', () => {
    expect(serializeConversation(conv('pending')).status).toBe('pending');
    expect(serializeConversation(conv('in_progress')).status).toBe('open');
    expect(serializeConversation(conv('waiting_customer')).status).toBe('open');
    expect(serializeConversation(conv('closed')).status).toBe('closed');
    expect(serializeConversation(conv('finalized')).status).toBe('closed');
  });
});

describe('toPublicConversationStatus', () => {
  it('maps every internal status to a value from the original public 3', () => {
    expect(toPublicConversationStatus('pending')).toBe('pending');
    expect(toPublicConversationStatus('in_progress')).toBe('open');
    expect(toPublicConversationStatus('waiting_customer')).toBe('open');
    expect(toPublicConversationStatus('closed')).toBe('closed');
    expect(toPublicConversationStatus('finalized')).toBe('closed');
  });
});

describe('fromPublicConversationStatusFilter', () => {
  it('maps ?status=open to both in_progress and waiting_customer', () => {
    expect(fromPublicConversationStatusFilter('open')).toEqual(['in_progress', 'waiting_customer']);
  });

  it('maps ?status=pending to just pending', () => {
    expect(fromPublicConversationStatusFilter('pending')).toEqual(['pending']);
  });

  it('maps ?status=closed to both closed and finalized', () => {
    expect(fromPublicConversationStatusFilter('closed')).toEqual(['closed', 'finalized']);
  });

  it('returns null for anything outside the three documented values', () => {
    expect(fromPublicConversationStatusFilter('in_progress')).toBeNull();
    expect(fromPublicConversationStatusFilter('bogus')).toBeNull();
    expect(fromPublicConversationStatusFilter('')).toBeNull();
  });
});

describe('serializeMessage', () => {
  it('maps message_id → whatsapp_message_id and derives direction', () => {
    const inbound = {
      id: 'm1',
      conversation_id: 'conv1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.123',
      status: 'delivered',
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as Message;
    const outMsg = serializeMessage(inbound);
    expect(outMsg.direction).toBe('inbound');
    expect(outMsg.whatsapp_message_id).toBe('wamid.123');
    expect(outMsg).not.toHaveProperty('message_id');

    const agent = { ...inbound, sender_type: 'agent' } as unknown as Message;
    expect(serializeMessage(agent).direction).toBe('outbound');
  });
});
