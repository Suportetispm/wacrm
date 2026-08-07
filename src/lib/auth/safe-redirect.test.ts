import { describe, expect, it } from 'vitest'

import { resolveSafeNextPath } from './safe-redirect'

const ALLOWED = ['/reset-password'] as const
const FALLBACK = '/login'

describe('resolveSafeNextPath', () => {
  it('allows an exact match from the allow-list', () => {
    expect(resolveSafeNextPath('/reset-password', ALLOWED, FALLBACK)).toBe('/reset-password')
  })

  it('falls back for null/undefined/empty input', () => {
    expect(resolveSafeNextPath(null, ALLOWED, FALLBACK)).toBe(FALLBACK)
    expect(resolveSafeNextPath(undefined, ALLOWED, FALLBACK)).toBe(FALLBACK)
    expect(resolveSafeNextPath('', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })

  it('blocks an absolute external URL', () => {
    expect(resolveSafeNextPath('https://evil.example', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })

  it('blocks a protocol-relative URL', () => {
    expect(resolveSafeNextPath('//evil.example', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })

  it('blocks a javascript: pseudo-scheme', () => {
    expect(resolveSafeNextPath('javascript:alert(1)', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })

  it('blocks an internal-looking path that is not on the allow-list', () => {
    expect(resolveSafeNextPath('/dashboard', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })

  it('blocks a path that merely starts with an allowed entry', () => {
    expect(resolveSafeNextPath('/reset-password/../evil', ALLOWED, FALLBACK)).toBe(FALLBACK)
  })
})
