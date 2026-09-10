import { afterEach, describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import GlobalError from './global-error';

const ORIGINAL_LOCALE = process.env.NEXT_PUBLIC_APP_LOCALE;

afterEach(() => {
  process.env.NEXT_PUBLIC_APP_LOCALE = ORIGINAL_LOCALE;
});

function render(error: Error & { digest?: string }) {
  return renderToStaticMarkup(
    React.createElement(GlobalError, { error, reset: () => {} }),
  );
}

describe('GlobalError (src/app/global-error.tsx)', () => {
  it('renders a full html/body document (it replaces the root layout)', () => {
    const html = render(new Error('boom'));
    expect(html).toContain('<html');
    expect(html).toContain('<body');
  });

  it('falls back to English when the locale is unset', () => {
    delete process.env.NEXT_PUBLIC_APP_LOCALE;
    const html = render(new Error('boom'));
    expect(html).toContain('Something went wrong');
  });

  it('renders Portuguese copy when NEXT_PUBLIC_APP_LOCALE=pt-BR', () => {
    process.env.NEXT_PUBLIC_APP_LOCALE = 'pt-BR';
    const html = render(new Error('boom'));
    expect(html).toContain('Algo deu errado');
  });

  it('renders Korean copy when NEXT_PUBLIC_APP_LOCALE=ko', () => {
    process.env.NEXT_PUBLIC_APP_LOCALE = 'ko';
    const html = render(new Error('boom'));
    expect(html).toContain('문제가 발생했습니다');
  });

  it('falls back to English for an unrecognized locale instead of crashing', () => {
    process.env.NEXT_PUBLIC_APP_LOCALE = 'xx-not-a-real-locale';
    const html = render(new Error('boom'));
    expect(html).toContain('Something went wrong');
  });

  it('never renders the raw error message', () => {
    const secret = 'connection to database failed: password authentication error';
    const html = render(new Error(secret));
    expect(html).not.toContain(secret);
    expect(html).not.toContain('password');
  });

  it('shows the digest as a safe reference when present', () => {
    const error = Object.assign(new Error('boom'), { digest: 'zz999digest' });
    const html = render(error);
    expect(html).toContain('zz999digest');
  });
});
