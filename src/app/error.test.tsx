import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Smoke test for the wrapper pattern shared by every segment's
// error.tsx ((dashboard), (auth), admin are identical thin wrappers
// around ErrorBoundaryFallback — see error-boundary-fallback.test.tsx
// for the actual content/leak coverage). This confirms the wrapper
// itself imports and renders correctly as a real route file, not just
// that the shared component works in isolation.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import RootSegmentError from './error';

describe('RootSegmentError (src/app/error.tsx)', () => {
  it('renders without throwing given a typical error+reset pair', () => {
    const html = renderToStaticMarkup(
      React.createElement(RootSegmentError, {
        error: new Error('boom'),
        reset: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
  });
});
