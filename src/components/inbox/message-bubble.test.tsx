import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// No jsdom/testing-library in this project's Vitest setup (environment:
// "node" in vitest.config.ts) — these tests pin the static markup the
// same way src/components/ui/dropdown-menu-group-label.test.tsx does.
// They cover rendering only; click → fetch → toast behavior needs a DOM
// and isn't exercised here.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === 'unavailable' && vars?.label) return `${vars.label} unavailable`;
    return key;
  },
}));

import { MessageBubble } from './message-bubble';
import { formatFileSize } from '@/lib/utils';
import type { Message } from '@/types';

const BASE_MESSAGE: Message = {
  id: 'message-1',
  conversation_id: 'conversation-1',
  sender_type: 'customer',
  content_type: 'document',
  status: 'delivered',
  created_at: '2026-01-01T12:00:00.000Z',
};

function renderBubble(message: Message) {
  return renderToStaticMarkup(React.createElement(MessageBubble, { message }));
}

describe('MessageBubble — document attachments', () => {
  it('renders the file name and formatted size when media_storage_path is present', () => {
    const message: Message = {
      ...BASE_MESSAGE,
      media_storage_path: 'account-1/conversation-1/deadbeef.pdf',
      media_file_name: 'Invoice.pdf',
      media_file_size: 2_500_000,
    };

    const html = renderBubble(message);

    expect(html).toContain('Invoice.pdf');
    expect(html).toContain(formatFileSize(2_500_000));
    expect(html).toContain('aria-label="viewDocument"');
    expect(html).toContain('aria-label="downloadDocument"');
  });

  it('never renders the raw storage path or media_metadata', () => {
    const message: Message = {
      ...BASE_MESSAGE,
      media_storage_path: 'account-1/conversation-1/deadbeef.pdf',
      media_file_name: 'Invoice.pdf',
      media_file_size: 2_500_000,
      media_metadata: { waMessageId: 'secret-internal-id' },
    };

    const html = renderBubble(message);

    expect(html).not.toContain('account-1/conversation-1/deadbeef.pdf');
    expect(html).not.toContain('secret-internal-id');
  });

  it('falls back to "unavailable" when there is neither a storage path nor a media_url', () => {
    const message: Message = {
      ...BASE_MESSAGE,
      media_storage_path: null,
      media_url: undefined,
    };

    const html = renderBubble(message);

    expect(html).toContain('document unavailable');
    expect(html).not.toContain('aria-label="viewDocument"');
  });
});
