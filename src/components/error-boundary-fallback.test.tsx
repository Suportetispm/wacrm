import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// No jsdom/testing-library in this project's Vitest setup (environment:
// "node" in vitest.config.ts) — same rendering-only approach as
// src/components/inbox/message-bubble.test.tsx and
// src/components/ui/dropdown-menu-group-label.test.tsx. Covers markup
// content only; the click → reset() wiring needs a real DOM and isn't
// exercised here (same documented boundary those tests already use).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === 'reference' && vars?.digest) return `reference:${vars.digest}`;
    return key;
  },
}));

import { ErrorBoundaryFallback } from './error-boundary-fallback';

function renderFallback(error: Error & { digest?: string }) {
  return renderToStaticMarkup(
    React.createElement(ErrorBoundaryFallback, { error, reset: () => {} }),
  );
}

describe('ErrorBoundaryFallback', () => {
  it('renders the title, description, and retry button', () => {
    const html = renderFallback(new Error('boom'));
    expect(html).toContain('title');
    expect(html).toContain('description');
    expect(html).toContain('retry');
  });

  it('exposes an accessible alert region', () => {
    const html = renderFallback(new Error('boom'));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('never renders the raw error message', () => {
    const secret = 'duplicate key value violates unique constraint "profiles_pkey"';
    const html = renderFallback(new Error(secret));
    expect(html).not.toContain(secret);
    expect(html).not.toContain('constraint');
    expect(html).not.toContain('duplicate key');
  });

  it('never renders the stack trace', () => {
    const error = new Error('boom');
    const html = renderFallback(error);
    // A stack trace always contains "at <file>:<line>:<col>" frames —
    // assert none of that shape leaked into the markup, rather than
    // relying on the exact (environment-dependent) stack string.
    expect(html).not.toMatch(/at .+:\d+:\d+/);
    if (error.stack) expect(html).not.toContain(error.stack);
  });

  it('shows the digest as a safe reference when Next.js provides one', () => {
    const error = Object.assign(new Error('boom'), { digest: 'abc123digest' });
    const html = renderFallback(error);
    expect(html).toContain('abc123digest');
  });

  it('omits the reference line entirely when there is no digest', () => {
    const html = renderFallback(new Error('boom'));
    expect(html).not.toContain('reference');
  });
});
