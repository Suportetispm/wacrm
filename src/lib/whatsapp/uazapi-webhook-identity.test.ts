import { describe, expect, it } from 'vitest'
import { classifyIdentifier, resolveCanonicalPhone } from './uazapi-webhook-identity'

describe('classifyIdentifier', () => {
  it('classifies a bare digit string (no @) as phone', () => {
    expect(classifyIdentifier('559891480229')).toEqual({ kind: 'phone', digits: '559891480229' })
  })

  it('classifies @s.whatsapp.net as phone', () => {
    expect(classifyIdentifier('559891480229@s.whatsapp.net')).toEqual({
      kind: 'phone',
      digits: '559891480229',
    })
  })

  it('classifies @lid as lid, never phone', () => {
    expect(classifyIdentifier('208756952567854@lid')).toEqual({ kind: 'lid', digits: '208756952567854' })
  })

  it('classifies an unrecognized suffix as unknown', () => {
    expect(classifyIdentifier('559891480229@g.us')).toEqual({ kind: 'unknown', digits: '559891480229' })
    expect(classifyIdentifier('559891480229@newformat.example')).toEqual({
      kind: 'unknown',
      digits: '559891480229',
    })
  })

  it('is case-insensitive on the suffix', () => {
    expect(classifyIdentifier('559891480229@S.WHATSAPP.NET').kind).toBe('phone')
    expect(classifyIdentifier('208756952567854@LID').kind).toBe('lid')
  })
})

describe('resolveCanonicalPhone', () => {
  // A. bare digits → accepted as phone.
  it('accepts a bare digit string as phone', () => {
    expect(resolveCanonicalPhone(['559891480229'])).toEqual({ phone: '559891480229', lidDetected: false })
  })

  // B. @s.whatsapp.net JID → resolves the digits.
  it('resolves the digits out of an @s.whatsapp.net JID', () => {
    expect(resolveCanonicalPhone(['559891480229@s.whatsapp.net'])).toEqual({
      phone: '559891480229',
      lidDetected: false,
    })
  })

  // C. @lid → never returns a phone.
  it('never returns a phone for an @lid-only candidate', () => {
    expect(resolveCanonicalPhone(['208756952567854@lid'])).toEqual({ phone: null, lidDetected: true })
  })

  // D. sender_pn (trusted, first) wins over a LID sender.
  it('prefers an earlier trusted candidate over a later LID candidate', () => {
    const senderPn = '559891480229'
    const sender = '208756952567854@lid'
    expect(resolveCanonicalPhone([senderPn, sender])).toEqual({
      phone: '559891480229',
      lidDetected: false, // resolved before the LID candidate was ever reached
    })
  })

  // E. LID sender, but a later structurally-trusted phone field (e.g. chat.phone) resolves it.
  it('falls through a LID candidate to a later real-phone candidate', () => {
    const sender = '208756952567854@lid'
    const chatPhone = '559891480229'
    expect(resolveCanonicalPhone([undefined, sender, chatPhone])).toEqual({
      phone: '559891480229',
      lidDetected: true,
    })
  })

  // F. LID-only, no phone anywhere → no phone fabricated.
  it('fabricates no phone when only a LID is present anywhere in the candidate list', () => {
    const result = resolveCanonicalPhone([undefined, '208756952567854@lid', undefined, undefined])
    expect(result.phone).toBeNull()
    expect(result.lidDetected).toBe(true)
  })

  // G. Unknown JID suffix → never assumed to be a phone.
  it('never treats an unrecognized JID suffix as a phone', () => {
    expect(resolveCanonicalPhone(['559891480229@g.us'])).toEqual({ phone: null, lidDetected: false })
  })

  // H. Same identity, same candidate shape → same result (text/image/document agree by construction, since all three now call this one function).
  it('is a pure function of its candidate list — same input, same output', () => {
    const candidates = ['559891480229', '208756952567854@lid']
    expect(resolveCanonicalPhone(candidates)).toEqual(resolveCanonicalPhone(candidates))
  })

  // I. Invalid / too short / too long digit runs are rejected.
  it('rejects a too-short digit run', () => {
    expect(resolveCanonicalPhone(['123456'])).toEqual({ phone: null, lidDetected: false })
  })

  it('rejects a too-long digit run', () => {
    expect(resolveCanonicalPhone(['1234567890123456'])).toEqual({ phone: null, lidDetected: false })
  })

  it('accepts the boundary lengths (7 and 15 digits)', () => {
    expect(resolveCanonicalPhone(['1234567']).phone).toBe('1234567')
    expect(resolveCanonicalPhone(['123456789012345']).phone).toBe('123456789012345')
  })

  it('skips non-string, empty, and whitespace-only candidates without throwing', () => {
    expect(resolveCanonicalPhone([undefined, null, 42, '', '   ', '559891480229'])).toEqual({
      phone: '559891480229',
      lidDetected: false,
    })
  })

  it('returns null with lidDetected false when nothing at all qualifies', () => {
    expect(resolveCanonicalPhone([undefined, null, ''])).toEqual({ phone: null, lidDetected: false })
  })
})
