import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-api')>()
  return { ...actual, getChatAvatar: vi.fn() }
})
vi.mock('./whatsapp-avatar-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./whatsapp-avatar-fetch')>()
  return { ...actual, fetchWhatsAppAvatarImage: vi.fn() }
})

import { getChatAvatar, UazapiHttpError } from './uazapi-api'
import { fetchWhatsAppAvatarImage, WhatsAppAvatarFetchError } from './whatsapp-avatar-fetch'
import {
  __resetContactAvatarSyncStateForTests,
  AVATAR_RECHECK_INTERVAL_MS,
  AVATAR_TRANSIENT_BACKOFF_MS,
  extractIndividualChatId,
  syncContactWhatsAppAvatar,
} from './contact-avatar-sync'

const avatarMock = vi.mocked(getChatAvatar)
const fetchImageMock = vi.mocked(fetchWhatsAppAvatarImage)

const ACCOUNT = '11111111-1111-1111-1111-111111111111'
const OTHER_ACCOUNT = '99999999-9999-9999-9999-999999999999'
const CONTACT = '22222222-2222-2222-2222-222222222222'
const CHAT_ID = '5591999999999@s.whatsapp.net'
const CDN_URL = 'https://pps.whatsapp.net/v/t61/x.jpg?oh=secret'
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)])
const JPEG_2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x99)])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const pathFor = (b: Buffer, account = ACCOUNT, contact = CONTACT) => `${account}/contacts/${contact}/${sha(b)}.jpg`

interface ContactRow {
  id: string
  account_id: string
  whatsapp_avatar_path: string | null
  whatsapp_avatar_checked_at: string | null
}

function fakeDb(opts: { contact?: ContactRow | null; lookupError?: unknown; updateError?: unknown; uploadError?: unknown } = {}) {
  const contacts: ContactRow[] = opts.contact === null ? [] : [opts.contact ?? { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: null }]
  const updates: { payload: Record<string, unknown>; filters: Record<string, unknown> }[] = []
  const upload = vi.fn(async () => ({ data: opts.uploadError ? null : { path: 'x' }, error: opts.uploadError ?? null }))
  const remove = vi.fn(async () => ({ data: {}, error: null }))
  const buckets: string[] = []

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
      const filters: Record<string, unknown> = {}
      let updatePayload: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        filters[col] = val
        return b
      }
      b.update = (payload: Record<string, unknown>) => {
        updatePayload = payload
        return b
      }
      b.maybeSingle = async () => {
        if (opts.lookupError) return { data: null, error: opts.lookupError }
        const row = contacts.find((c) => c.id === filters.id && c.account_id === filters.account_id)
        return { data: row ?? null, error: null }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (updatePayload) updates.push({ payload: updatePayload, filters: { ...filters } })
        return Promise.resolve({ error: opts.updateError ?? null }).then(resolve)
      }
      return b
    },
    storage: {
      from(bucket: string) {
        buckets.push(bucket)
        return { upload, remove }
      },
    },
    __updates: updates,
    __upload: upload,
    __remove: remove,
    __buckets: buckets,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const getInstanceToken = vi.fn(async () => 'token-of-this-connection')
let errorSpy: ReturnType<typeof vi.spyOn>

function run(db: unknown, overrides: Partial<Parameters<typeof syncContactWhatsAppAvatar>[0]> = {}) {
  return syncContactWhatsAppAvatar({
    db: db as never,
    accountId: ACCOUNT,
    contactId: CONTACT,
    chatId: CHAT_ID,
    getInstanceToken,
    now: () => NOW,
    ...overrides,
  })
}

beforeEach(() => {
  __resetContactAvatarSyncStateForTests()
  avatarMock.mockReset()
  fetchImageMock.mockReset()
  getInstanceToken.mockClear()
  avatarMock.mockResolvedValue({ url: CDN_URL })
  fetchImageMock.mockResolvedValue({ buffer: JPEG, format: 'jpeg' })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('extractIndividualChatId — raw webhook payload, no parser changes', () => {
  const base = (message: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) => ({
    EventType: 'messages',
    chat: { wa_isGroup: false, ...chat },
    message: { chatid: CHAT_ID, fromMe: false, wasSentByApi: false, isGroup: false, messageType: 'Conversation', ...message },
  })

  it('returns the chatid exactly as UAZAPI sent it for an inbound individual TEXT message', () => {
    expect(extractIndividualChatId(base())).toBe(CHAT_ID)
    expect(extractIndividualChatId(base({ chatid: '123456789012345@lid' }))).toBe('123456789012345@lid')
  })

  it('ignores groups (@g.us, isGroup, wa_isGroup), fromMe, API echoes and non-message events', () => {
    expect(extractIndividualChatId(base({ chatid: '120363000000000000@g.us' }))).toBeNull()
    expect(extractIndividualChatId(base({ isGroup: true }))).toBeNull()
    expect(extractIndividualChatId(base({}, { wa_isGroup: true }))).toBeNull()
    expect(extractIndividualChatId(base({ fromMe: true }))).toBeNull()
    expect(extractIndividualChatId(base({ wasSentByApi: true }))).toBeNull()
    expect(extractIndividualChatId(base({ chatid: '123@newsletter' }))).toBeNull()
    expect(extractIndividualChatId({ EventType: 'connection' })).toBeNull()
  })
})

describe('syncContactWhatsAppAvatar — happy paths', () => {
  it('first query (checked_at NULL): asks UAZAPI with the chatId + THIS connection token, stores by content hash', async () => {
    const db = fakeDb()
    expect(await run(db)).toBe('updated')

    expect(getInstanceToken).toHaveBeenCalledTimes(1)
    expect(avatarMock).toHaveBeenCalledWith({ instanceToken: 'token-of-this-connection', number: CHAT_ID, preview: true })
    const avatarArgs = avatarMock.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(avatarArgs.preview).toBe(true)
    expect(avatarArgs).not.toHaveProperty('force')
    expect(fetchImageMock).toHaveBeenCalledWith({ url: CDN_URL })

    const [path, , uploadOpts] = db.__upload.mock.calls[0]
    expect(path).toBe(pathFor(JPEG))
    expect(path.startsWith(`${ACCOUNT}/contacts/${CONTACT}/`)).toBe(true)
    expect(path).not.toContain('5591999999999')
    expect(uploadOpts).toMatchObject({ contentType: 'image/jpeg', upsert: false })
    expect(db.__buckets.every((b: string) => b === 'whatsapp-attachments')).toBe(true)

    expect(db.__updates).toHaveLength(1)
    expect(db.__updates[0].payload).toEqual({
      whatsapp_avatar_path: pathFor(JPEG),
      whatsapp_avatar_checked_at: new Date(NOW).toISOString(),
    })
    expect(db.__updates[0].filters).toMatchObject({ id: CONTACT, account_id: ACCOUNT })
  })

  it('within 7 days of the last check: no token lookup, no UAZAPI call', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(NOW - AVATAR_RECHECK_INTERVAL_MS + 60_000).toISOString() },
    })
    expect(await run(db)).toBe('fresh')
    expect(getInstanceToken).not.toHaveBeenCalled()
    expect(avatarMock).not.toHaveBeenCalled()
  })

  it('after 7 days: queries again', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(NOW - AVATAR_RECHECK_INTERVAL_MS - 1).toISOString() },
    })
    expect(await run(db)).toBe('updated')
    expect(avatarMock).toHaveBeenCalledTimes(1)
  })

  it('same photo: reuses the path, only refreshes checked_at, no upload', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null },
    })
    expect(await run(db)).toBe('unchanged')
    expect(db.__upload).not.toHaveBeenCalled()
    expect(db.__remove).not.toHaveBeenCalled()
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
  })

  it('changed photo: new hash → new file → path updated → old file removed AFTER the update', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null },
    })
    fetchImageMock.mockResolvedValue({ buffer: JPEG_2, format: 'jpeg' })

    expect(await run(db)).toBe('updated')
    expect(db.__upload.mock.calls[0][0]).toBe(pathFor(JPEG_2))
    expect(db.__updates[0].payload.whatsapp_avatar_path).toBe(pathFor(JPEG_2))
    expect(db.__remove).toHaveBeenCalledWith([pathFor(JPEG)])
  })

  it('same hash already in storage (upload conflict): reused, not an error', async () => {
    const db = fakeDb({ uploadError: { message: 'The resource already exists', statusCode: '409' } })
    expect(await run(db)).toBe('updated')
    expect(db.__updates[0].payload.whatsapp_avatar_path).toBe(pathFor(JPEG))
  })

  it('photo removed (url ""): path cleared, checked_at set, old file removed', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null },
    })
    avatarMock.mockResolvedValue({ url: '' })

    expect(await run(db)).toBe('no_photo')
    expect(fetchImageMock).not.toHaveBeenCalled()
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
    expect(db.__remove).toHaveBeenCalledWith([pathFor(JPEG)])
  })
})

describe('syncContactWhatsAppAvatar — failures keep the current photo', () => {
  const withPhoto = () => fakeDb({ contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null } })

  it('UAZAPI 429: reported as throttled — same transient effects (no DB write, photo kept, backoff)', async () => {
    const db = withPhoto()
    avatarMock.mockRejectedValue(new UazapiHttpError(429, 'x'))

    expect(await run(db)).toBe('throttled')
    expect(db.__updates).toHaveLength(0)
    expect(db.__remove).not.toHaveBeenCalled()
    expect(await run(db)).toBe('skipped_backoff')
    expect(avatarMock).toHaveBeenCalledTimes(1)
    expect(await run(db, { now: () => NOW + AVATAR_TRANSIENT_BACKOFF_MS + 1 })).toBe('throttled')
  })

  it.each([500, 503, 401])('UAZAPI %i: transient — no DB write, photo kept, in-memory backoff (no retry on the next message)', async (status) => {
    const db = withPhoto()
    avatarMock.mockRejectedValue(new UazapiHttpError(status, 'x'))

    expect(await run(db)).toBe('transient_error')
    expect(db.__updates).toHaveLength(0)
    expect(db.__remove).not.toHaveBeenCalled()

    expect(await run(db)).toBe('skipped_backoff')
    expect(avatarMock).toHaveBeenCalledTimes(1)

    // After the backoff window it retries (no 7-day cooldown for a blip).
    expect(await run(db, { now: () => NOW + AVATAR_TRANSIENT_BACKOFF_MS + 1 })).toBe('transient_error')
    expect(avatarMock).toHaveBeenCalledTimes(2)
  })

  it.each([400, 404])('UAZAPI %i: deterministic — marks checked_at only, photo kept', async (status) => {
    const db = withPhoto()
    avatarMock.mockRejectedValue(new UazapiHttpError(status, 'x'))
    expect(await run(db)).toBe('refused')
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
  })

  it.each([
    ['host / protocol / port / credentials / invalid URL', 'url_not_allowed'],
    ['MIME refused or Content-Type missing (HTML, JSON, SVG, GIF…)', 'content_type_refused'],
    ['real signature mismatch', 'signature_mismatch'],
    ['size above the limit', 'too_large'],
    ['empty body', 'empty'],
    ['redirect', 'redirect_refused'],
  ] as const)(
    'security refusal (%s): photo kept, checked_at NOT updated, 1-hour backoff applied',
    async (_label, code) => {
      const db = withPhoto()
      fetchImageMock.mockRejectedValue(new WhatsAppAvatarFetchError(code))

      expect(await run(db)).toBe('refused')
      expect(db.__upload).not.toHaveBeenCalled()
      expect(db.__remove).not.toHaveBeenCalled()
      expect(db.__updates).toHaveLength(0)

      // Backoff: the next message doesn't retry…
      expect(await run(db)).toBe('skipped_backoff')
      expect(avatarMock).toHaveBeenCalledTimes(1)
      // …but after an hour it does (no 7-day cooldown).
      expect(await run(db, { now: () => NOW + AVATAR_TRANSIENT_BACKOFF_MS + 1 })).toBe('refused')
      expect(avatarMock).toHaveBeenCalledTimes(2)
      expect(db.__updates).toHaveLength(0)
    },
  )

  it.each(['timeout', 'network_error', 'http_error'] as const)('download %s: transient — no DB write, photo kept, backoff', async (code) => {
    const db = withPhoto()
    fetchImageMock.mockRejectedValue(new WhatsAppAvatarFetchError(code))
    expect(await run(db)).toBe('transient_error')
    expect(db.__updates).toHaveLength(0)
    expect(db.__remove).not.toHaveBeenCalled()
    expect(await run(db)).toBe('skipped_backoff')
  })

  it('upload failure: transient — no DB write, photo kept, backoff', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null },
      uploadError: { message: 'storage unavailable', statusCode: '500' },
    })
    fetchImageMock.mockResolvedValue({ buffer: JPEG_2, format: 'jpeg' })
    expect(await run(db)).toBe('transient_error')
    expect(db.__updates).toHaveLength(0)
    expect(await run(db)).toBe('skipped_backoff')
  })

  it('DB lookup failure: no write, backoff', async () => {
    const db = fakeDb({ lookupError: { code: '57014' } })
    expect(await run(db)).toBe('database_error')
    expect(await run(db)).toBe('skipped_backoff')
  })

  it('token unavailable: transient, UAZAPI never called', async () => {
    const db = withPhoto()
    getInstanceToken.mockRejectedValueOnce(new Error('token_unavailable'))
    expect(await run(db)).toBe('transient_error')
    expect(avatarMock).not.toHaveBeenCalled()
  })

  it('DB update fails after upload: the new object is removed (no orphan), old photo untouched', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null },
      updateError: { code: '57014' },
    })
    fetchImageMock.mockResolvedValue({ buffer: JPEG_2, format: 'jpeg' })
    expect(await run(db)).toBe('database_error')
    expect(db.__remove).toHaveBeenCalledWith([pathFor(JPEG_2)])
    expect(db.__remove).not.toHaveBeenCalledWith([pathFor(JPEG)])
  })

  it('never deletes a path outside this contact\'s own prefix', async () => {
    const foreign = pathFor(JPEG, OTHER_ACCOUNT)
    const db = fakeDb({ contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: foreign, whatsapp_avatar_checked_at: null } })
    avatarMock.mockResolvedValue({ url: '' })
    expect(await run(db)).toBe('no_photo')
    expect(db.__remove).not.toHaveBeenCalled()
  })
})

describe('syncContactWhatsAppAvatar — isolation and input guards', () => {
  it('a contact of another account is never found (lookup is scoped by account_id)', async () => {
    const db = fakeDb({ contact: { id: CONTACT, account_id: OTHER_ACCOUNT, whatsapp_avatar_path: null, whatsapp_avatar_checked_at: null } })
    expect(await run(db)).toBe('skipped_not_found')
    expect(avatarMock).not.toHaveBeenCalled()
  })

  it('group chat ids and malformed ids are refused before any I/O', async () => {
    const db = fakeDb()
    expect(await run(db, { chatId: '120363000000000000@g.us' })).toBe('skipped_invalid_input')
    expect(await run(db, { accountId: 'not-a-uuid' })).toBe('skipped_invalid_input')
    expect(avatarMock).not.toHaveBeenCalled()
  })

  it('never logs the CDN URL, chatId/phone or token', async () => {
    const db = fakeDb()
    fetchImageMock.mockRejectedValue(new WhatsAppAvatarFetchError('signature_mismatch'))
    await run(db)
    const logged = JSON.stringify(errorSpy.mock.calls)
    for (const s of [CDN_URL, 'secret', CHAT_ID, '5591999999999', 'token-of-this-connection']) {
      expect(logged).not.toContain(s)
    }
  })
})

describe('syncContactWhatsAppAvatar — mode (webhook vs background Inbox sync)', () => {
  const PHONE_DIGITS = '5591999999999'
  const withPhoto = () =>
    fakeDb({ contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: null } })

  it('webhook mode (default) keeps the existing semantics: url "" clears the photo', async () => {
    const db = withPhoto()
    avatarMock.mockResolvedValue({ url: '' })
    expect(await run(db, { mode: 'webhook' })).toBe('no_photo')
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
    expect(db.__remove).toHaveBeenCalledWith([pathFor(JPEG)])
  })

  it('background mode: url "" NEVER removes an existing photo — only checked_at is marked', async () => {
    const db = withPhoto()
    avatarMock.mockResolvedValue({ url: '' })
    expect(await run(db, { mode: 'background', chatId: PHONE_DIGITS })).toBe('no_photo_kept')
    expect(db.__updates).toHaveLength(1)
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
    expect(db.__remove).not.toHaveBeenCalled()
    expect(fetchImageMock).not.toHaveBeenCalled()
  })

  it('background mode without a stored photo: url "" is a plain no_photo (checked_at set, nothing to remove)', async () => {
    const db = fakeDb()
    avatarMock.mockResolvedValue({ url: '' })
    expect(await run(db, { mode: 'background', chatId: PHONE_DIGITS })).toBe('no_photo')
    expect(db.__updates[0].payload).toEqual({ whatsapp_avatar_path: null, whatsapp_avatar_checked_at: new Date(NOW).toISOString() })
    expect(db.__remove).not.toHaveBeenCalled()
  })

  it('background mode: sends the stored phone digits as `number` (no JID built), preview true, no force', async () => {
    const db = fakeDb()
    expect(await run(db, { mode: 'background', chatId: PHONE_DIGITS })).toBe('updated')
    expect(avatarMock).toHaveBeenCalledWith({ instanceToken: 'token-of-this-connection', number: PHONE_DIGITS, preview: true })
    expect(avatarMock.mock.calls[0][0]).not.toHaveProperty('force')
  })

  it('background mode respects the 7-day cooldown (fresh: no token, no UAZAPI call)', async () => {
    const db = fakeDb({
      contact: { id: CONTACT, account_id: ACCOUNT, whatsapp_avatar_path: pathFor(JPEG), whatsapp_avatar_checked_at: new Date(NOW - 1000).toISOString() },
    })
    expect(await run(db, { mode: 'background', chatId: PHONE_DIGITS })).toBe('fresh')
    expect(getInstanceToken).not.toHaveBeenCalled()
    expect(avatarMock).not.toHaveBeenCalled()
  })

  it('in-flight dedup: a second call for the same contact while one runs is skipped', async () => {
    const db = fakeDb()
    let release!: () => void
    avatarMock.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ url: '' }))))
    const first = run(db, { mode: 'background', chatId: PHONE_DIGITS })
    await vi.waitFor(() => expect(avatarMock).toHaveBeenCalledTimes(1))
    expect(await run(db, { mode: 'background', chatId: PHONE_DIGITS })).toBe('skipped_in_flight')
    release()
    expect(await first).toBe('no_photo')
  })
})

describe('extractIndividualChatId — real voice-note (PTT AudioMessage) shape', () => {
  // Same real-shaped fixture as uazapi-webhook-audio-parser.test.ts
  // (structure of a captured inbound voice note; values synthetic).
  const realVoiceNote = (message: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) => ({
    EventType: 'messages',
    token: 'fixture-token',
    owner: '5591900000000',
    BaseUrl: 'https://example.uazapi.test',
    chat: { phone: '+55 91 99999-9999', wa_chatid: CHAT_ID, wa_isGroup: false, ...chat },
    message: {
      id: 'dl-id-1',
      messageid: 'msg-id-1',
      chatid: CHAT_ID,
      sender: CHAT_ID,
      sender_pn: CHAT_ID,
      senderName: 'Cliente Teste',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      messageType: 'AudioMessage',
      type: 'media',
      mediaType: 'ptt',
      messageTimestamp: 1735686000000,
      content: {
        URL: 'https://example.uazapi.test/media/secret-audio',
        directPath: '/v/t62.7117-24/secret-path',
        fileLength: 5_432,
        mimetype: 'audio/ogg; codecs=opus',
        seconds: 3,
        PTT: true,
      },
      ...message,
    },
  })

  it('returns the same chatid the real audio parser reads — audio and text agree', async () => {
    const { parseInboundAudioMessage } = await import('./uazapi-webhook-audio-parser')
    const payload = realVoiceNote()
    expect(parseInboundAudioMessage(payload)?.chatId).toBe(CHAT_ID)
    expect(extractIndividualChatId(payload)).toBe(CHAT_ID)
  })

  it('non-PTT audio file (mediaType "audio") also yields the chatid', () => {
    expect(extractIndividualChatId(realVoiceNote({ mediaType: 'audio' }))).toBe(CHAT_ID)
  })

  it('a group voice note is ignored', () => {
    expect(extractIndividualChatId(realVoiceNote({ isGroup: true }))).toBeNull()
    expect(extractIndividualChatId(realVoiceNote({ chatid: '120363000000000000@g.us' }))).toBeNull()
  })
})
