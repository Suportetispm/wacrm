import { describe, expect, it } from 'vitest'

import { resolveTrustedOrigin } from './site-url'

describe('resolveTrustedOrigin', () => {
  it('prefers NEXT_PUBLIC_SITE_URL when set', () => {
    expect(resolveTrustedOrigin('https://browser.example', 'https://canonical.example')).toBe(
      'https://canonical.example',
    )
  })

  it('strips a trailing slash from the configured site URL', () => {
    expect(resolveTrustedOrigin('https://browser.example', 'https://canonical.example/')).toBe(
      'https://canonical.example',
    )
  })

  it('falls back to the browser origin when unset', () => {
    expect(resolveTrustedOrigin('https://browser.example', undefined)).toBe(
      'https://browser.example',
    )
  })

  it('falls back to the browser origin when blank/whitespace', () => {
    expect(resolveTrustedOrigin('https://browser.example', '   ')).toBe('https://browser.example')
  })

  it('never hardcodes localhost — the fallback is always the passed-in origin', () => {
    expect(resolveTrustedOrigin('https://app.production.example', undefined)).not.toContain(
      'localhost',
    )
  })
})
