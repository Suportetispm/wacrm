import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { canZoomAvatar, ContactAvatar, contactAvatarSources, pickAvatarSource } from './contact-avatar'

const CONTACT_ID = '22222222-2222-2222-2222-222222222222'
const HASH = 'ab'.repeat(32)
const WA_PATH = `11111111-1111-1111-1111-111111111111/contacts/${CONTACT_ID}/${HASH}.jpg`

function render(contact: Parameters<typeof ContactAvatar>[0]['contact']) {
  return renderToStaticMarkup(
    React.createElement(ContactAvatar, {
      contact,
      alt: 'Cliente',
      fallback: 'CL',
      imgClassName: 'h-10 w-10 rounded-full object-cover',
    }),
  )
}

describe('ContactAvatar — source priority', () => {
  it('WhatsApp photo available: renders our authenticated route (never UAZAPI/WhatsApp directly), versioned by content hash', () => {
    const html = render({ id: CONTACT_ID, whatsapp_avatar_path: WA_PATH, avatar_url: 'https://legacy.example/a.png' })
    expect(html).toContain(`src="/api/contacts/${CONTACT_ID}/avatar?v=${HASH.slice(0, 16)}"`)
    expect(html).not.toContain('pps.whatsapp.net')
    expect(html).not.toContain(WA_PATH)
    expect(html).toContain('class="h-10 w-10 rounded-full object-cover"')
  })

  it('no WhatsApp photo: falls back to the legacy avatar_url', () => {
    const html = render({ id: CONTACT_ID, whatsapp_avatar_path: null, avatar_url: 'https://legacy.example/a.png' })
    expect(html).toContain('src="https://legacy.example/a.png"')
  })

  it('no photo at all: renders the caller\'s initials, no <img>', () => {
    const html = render({ id: CONTACT_ID, whatsapp_avatar_path: null, avatar_url: undefined })
    expect(html).toBe('CL')
    expect(render(null)).toBe('CL')
  })

  it('a malformed stored path is ignored (no route URL built from it)', () => {
    expect(contactAvatarSources({ id: CONTACT_ID, whatsapp_avatar_path: 'weird/path.gif' })).toEqual([])
  })
})

describe('pickAvatarSource — load errors fall back without loops', () => {
  it('a failed WhatsApp photo falls back to avatar_url, then to initials, and a failed source is never retried', () => {
    const sources = contactAvatarSources({ id: CONTACT_ID, whatsapp_avatar_path: WA_PATH, avatar_url: 'https://legacy.example/a.png' })
    expect(sources).toHaveLength(2)

    const failed = new Set<string>()
    expect(pickAvatarSource(sources, failed)).toBe(sources[0])
    failed.add(sources[0])
    expect(pickAvatarSource(sources, failed)).toBe(sources[1])
    failed.add(sources[1])
    expect(pickAvatarSource(sources, failed)).toBeNull()
  })
})

describe('ContactAvatar — version returned by the background sync', () => {
  it('a version from POST /api/contacts/avatar-sync makes it try our route even before any path is known', () => {
    expect(contactAvatarSources({ id: CONTACT_ID, whatsapp_avatar_path: null, whatsapp_avatar_version: '0123456789abcdef' })).toEqual([
      `/api/contacts/${CONTACT_ID}/avatar?v=0123456789abcdef`,
    ])
  })

  it('a null version from the sync means "no synced photo" and overrides a stale path', () => {
    expect(
      contactAvatarSources({ id: CONTACT_ID, whatsapp_avatar_path: WA_PATH, whatsapp_avatar_version: null, avatar_url: 'https://legacy.example/a.png' }),
    ).toEqual(['https://legacy.example/a.png'])
  })

  it('a malformed version is ignored', () => {
    expect(contactAvatarSources({ id: CONTACT_ID, whatsapp_avatar_version: '../../x' })).toEqual([])
  })
})

describe('ContactAvatar — enlarge (header / sidebar only)', () => {
  const ZOOM = { openLabel: 'Ver foto de Cliente', title: 'Foto de perfil de Cliente', closeLabel: 'Fechar foto' }

  function renderZoom(contact: Parameters<typeof ContactAvatar>[0]['contact']) {
    return renderToStaticMarkup(
      React.createElement(ContactAvatar, { contact, alt: 'Cliente', fallback: 'CL', imgClassName: 'h-9 w-9', zoom: ZOOM }),
    )
  }

  it('synced WhatsApp photo: wrapped in an accessible button (dialog trigger), disabled until the image has loaded', () => {
    const html = renderZoom({ id: CONTACT_ID, whatsapp_avatar_path: WA_PATH })
    expect(html).toMatch(/^<button type="button"/)
    expect(html).toContain('aria-label="Ver foto de Cliente"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('disabled=""')
    expect(html).toContain(`src="/api/contacts/${CONTACT_ID}/avatar?v=${HASH.slice(0, 16)}"`)
    expect(html).not.toContain(WA_PATH)
    // Dialog is closed: nothing rendered for it yet.
    expect(html).not.toContain('Foto de perfil de Cliente')
  })

  it('legacy avatar_url is never enlargeable', () => {
    const html = renderZoom({ id: CONTACT_ID, whatsapp_avatar_path: null, avatar_url: 'https://legacy.example/a.png' })
    expect(html).not.toContain('<button')
    expect(html).toContain('src="https://legacy.example/a.png"')
  })

  it('initials are never clickable', () => {
    expect(renderZoom({ id: CONTACT_ID, whatsapp_avatar_path: null })).toBe('CL')
  })

  it('without `zoom` (conversation-list row) the synced photo stays a plain image', () => {
    expect(render({ id: CONTACT_ID, whatsapp_avatar_path: WA_PATH })).not.toContain('<button')
  })

  it('canZoomAvatar: only the synced source, only once it actually loaded', () => {
    const contact = { id: CONTACT_ID, whatsapp_avatar_path: WA_PATH, avatar_url: 'https://legacy.example/a.png' }
    const [synced, legacy] = contactAvatarSources(contact)
    expect(canZoomAvatar(contact, synced, null)).toBe(false)
    expect(canZoomAvatar(contact, synced, synced)).toBe(true)
    // After the synced photo failed, the legacy fallback is shown — not enlargeable even if loaded.
    expect(canZoomAvatar(contact, legacy, legacy)).toBe(false)
    expect(canZoomAvatar(contact, null, null)).toBe(false)
  })
})
