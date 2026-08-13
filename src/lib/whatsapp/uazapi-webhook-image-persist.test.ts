import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedInboundImageMessage } from './uazapi-webhook-image-parser'

vi.mock('./uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-api')>()
  return {
    ...actual,
    downloadMessageMedia: vi.fn(),
  }
})

import { downloadMessageMedia, UazapiHttpError } from './uazapi-api'
import { persistInboundImageMessage } from './uazapi-webhook-image-persist'

const downloadMock = vi.mocked(downloadMessageMedia)

const TWENTY_MB = 20 * 1024 * 1024

function base64CharsForDecodedBytes(decodedBytes: number): number {
  return Math.ceil((decodedBytes * 4) / 3 / 4) * 4
}

function jpegBuffer(fillerBytes = 100): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(fillerBytes, 0x11)])
}
function pngBuffer(fillerBytes = 100): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(fillerBytes, 0x22),
  ])
}
function webpBuffer(fillerBytes = 100): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(fillerBytes, 0x33),
  ])
}

const VALID_JPEG_BASE64 = jpegBuffer().toString('base64')
const VALID_PNG_BASE64 = pngBuffer().toString('base64')
const VALID_WEBP_BASE64 = webpBuffer().toString('base64')
const NOT_AN_IMAGE_BASE64 = Buffer.from('this is definitely not an image file').toString('base64')

interface TableResponse {
  data: unknown
  error: unknown
}

// Same minimal fake Supabase query-builder as
// uazapi-webhook-document-persist.test.ts — every chain method returns
// itself; `.single()`/`.maybeSingle()`/awaiting the builder directly
// resolve to the next queued response for that table.
function makeChainable(response: TableResponse) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.eq = chain
  builder.like = chain
  builder.order = chain
  builder.limit = chain
  builder.insert = chain
  builder.single = async () => response
  builder.maybeSingle = async () => response
  builder.then = (resolve: (v: TableResponse) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return builder
}

interface FakeDbOptions {
  contactsQueue?: TableResponse[]
  conversationsQueue?: TableResponse[]
  messagesQueue?: TableResponse[]
  rpcResult?: TableResponse
  uploadError?: unknown
  removeError?: unknown
}

function createFakeDb(opts: FakeDbOptions = {}) {
  const queues: Record<string, TableResponse[]> = {
    contacts: opts.contactsQueue ? [...opts.contactsQueue] : [{ data: [], error: null }],
    conversations: opts.conversationsQueue
      ? [...opts.conversationsQueue]
      : [{ data: [], error: null }],
    messages: opts.messagesQueue ? [...opts.messagesQueue] : [{ data: null, error: null }],
  }

  const upload = vi.fn(async () => ({
    data: opts.uploadError ? null : { path: 'uploaded' },
    error: opts.uploadError ?? null,
  }))
  const remove = vi.fn(async () => ({
    data: opts.removeError ? null : {},
    error: opts.removeError ?? null,
  }))
  const rpc = vi.fn(async () => opts.rpcResult ?? { data: 'persisted', error: null })

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      const queue = queues[table]
      const response = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null }
      return makeChainable(response)
    },
    rpc,
    storage: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- fake bucket router; only one bucket is ever used, name isn't asserted on
      from(bucket: string) {
        return { upload, remove }
      },
    },
    __mocks: { upload, remove, rpc },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function baseParsed(overrides: Partial<ParsedInboundImageMessage> = {}): ParsedInboundImageMessage {
  return {
    providerMessageId: 'dedup-id-123',
    providerDownloadId: 'download-id-456',
    chatId: '5591999999999@s.whatsapp.net',
    sender: '5591999999999@s.whatsapp.net',
    senderName: 'Cliente Teste',
    occurredAt: new Date('2026-01-01T12:00:00Z').toISOString(),
    mimeType: 'image/jpeg',
    fileSize: 12345,
    width: 1280,
    height: 720,
    caption: undefined,
    fileName: 'image.jpg',
    ...overrides,
  }
}

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111'
const CONTACT_ID = '22222222-2222-2222-2222-222222222222'
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333'
const OTHER_ACCOUNT_ID = '99999999-9999-9999-9999-999999999999'

const NEW_CONTACT_ROW = { id: CONTACT_ID, account_id: ACCOUNT_ID, phone: '5591999999999' }
const NEW_CONVERSATION_ROW = { id: CONVERSATION_ID, account_id: ACCOUNT_ID, contact_id: CONTACT_ID }

/** Queues for "no existing contact/conversation, both get created". */
function freshEntityQueues() {
  return {
    contactsQueue: [
      { data: [], error: null },
      { data: NEW_CONTACT_ROW, error: null },
    ],
    conversationsQueue: [
      { data: [], error: null },
      { data: NEW_CONVERSATION_ROW, error: null },
    ],
  }
}

const ARGS_BASE = {
  accountId: ACCOUNT_ID,
  configOwnerUserId: 'user-1',
  instanceToken: 'test-instance-token',
}

beforeEach(() => {
  downloadMock.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('persistInboundImageMessage — happy path', () => {
  it('downloads, validates, uploads, and persists a valid JPEG', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64, mimetype: 'image/jpeg' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'persisted' })
    expect(downloadMock).toHaveBeenCalledWith({
      instanceToken: 'test-instance-token',
      id: 'download-id-456',
      returnBase64: true,
      returnLink: false,
    })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1)
    expect(db.__mocks.rpc).toHaveBeenCalledTimes(1)
    expect(db.__mocks.rpc.mock.calls[0][0]).toBe('uazapi_persist_inbound_image_message')
    const rpcArgs = db.__mocks.rpc.mock.calls[0][1]
    expect(rpcArgs.p_account_id).toBe(ACCOUNT_ID)
    expect(rpcArgs.p_conversation_id).toBe(CONVERSATION_ID)
    expect(rpcArgs.p_message_id).toBe('dedup-id-123')
    expect(rpcArgs.p_media_mime_type).toBe('image/jpeg')
    expect(rpcArgs.p_media_metadata).toEqual({
      captionPresent: false,
      decodedSize: expect.any(Number),
      format: 'jpeg',
      width: 1280,
      height: 720,
    })
  })

  it('accepts a valid PNG and a valid WebP', async () => {
    downloadMock.mockResolvedValueOnce({ base64Data: VALID_PNG_BASE64 })
    const dbPng = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })
    const pngResult = await persistInboundImageMessage({
      db: dbPng,
      ...ARGS_BASE,
      parsed: baseParsed({ mimeType: 'image/png', fileName: 'image.png' }),
    })
    expect(pngResult).toEqual({ outcome: 'persisted' })
    expect(dbPng.__mocks.rpc.mock.calls[0][1].p_media_metadata.format).toBe('png')

    downloadMock.mockResolvedValueOnce({ base64Data: VALID_WEBP_BASE64 })
    const dbWebp = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })
    const webpResult = await persistInboundImageMessage({
      db: dbWebp,
      ...ARGS_BASE,
      parsed: baseParsed({ mimeType: 'image/webp', fileName: 'image.webp' }),
    })
    expect(webpResult).toEqual({ outcome: 'persisted' })
    expect(dbWebp.__mocks.rpc.mock.calls[0][1].p_media_metadata.format).toBe('webp')
  })

  it('uses a deterministic path derived from accountId/conversationId/providerMessageId, extension matching the DETECTED format', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const [path] = db.__mocks.upload.mock.calls[0]
    expect(path.startsWith(`${ACCOUNT_ID}/${CONVERSATION_ID}/`)).toBe(true)
    expect(path.endsWith('.jpg')).toBe(true)
    expect(path).not.toContain('dedup-id-123')
  })

  it('sets captionPresent true when a caption exists, without storing the caption text itself in metadata', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundImageMessage({
      db,
      ...ARGS_BASE,
      parsed: baseParsed({ caption: 'olha essa foto' }),
    })

    const metadata = db.__mocks.rpc.mock.calls[0][1].p_media_metadata
    expect(metadata.captionPresent).toBe(true)
    expect(JSON.stringify(metadata)).not.toContain('olha essa foto')
  })
})

describe('persistInboundImageMessage — known duplicate (no new upload)', () => {
  it('returns duplicate without ever calling downloadMessageMedia or uploading, when the message is already persisted', async () => {
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: { id: 'existing-message-id' }, error: null }],
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'duplicate' })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('persistInboundImageMessage — file validation', () => {
  it('rejects when downloadMessageMedia returns no base64Data (fails closed, never falls back to fileUrl)', async () => {
    downloadMock.mockResolvedValue({ fileUrl: 'https://uazapi.example/file.jpg' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a download failure (UazapiHttpError) as download_failed', async () => {
    downloadMock.mockRejectedValue(new UazapiHttpError(404, 'Message not found'))
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
  })

  it('rejects content with no recognizable image signature', async () => {
    downloadMock.mockResolvedValue({ base64Data: NOT_AN_IMAGE_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a MIME/signature mismatch — declared JPEG, real bytes are a PNG', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PNG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({
      db,
      ...ARGS_BASE,
      parsed: baseParsed({ mimeType: 'image/jpeg' }),
    })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a mimetype mismatch reported by the download response even when the signature matches the declared type', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64, mimetype: 'image/png' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a decoded file above the 20 MB limit before ever calling Buffer.from on it', async () => {
    const oversizedBase64 = 'A'.repeat(base64CharsForDecodedBytes(TWENTY_MB + 1000))
    downloadMock.mockResolvedValue({ base64Data: oversizedBase64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundImageMessage — upload failures', () => {
  it('returns upload_failed and never calls the RPC when the upload fails for a reason other than "already exists"', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'Network error', statusCode: '500' },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'upload_failed' })
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('treats an "already exists" upload error as informational and still proceeds to the RPC', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'The resource already exists', statusCode: '409' },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'persisted' })
    expect(db.__mocks.rpc).toHaveBeenCalledTimes(1)
  })
})

describe('persistInboundImageMessage — RPC failure and cleanup (concurrency-safe)', () => {
  it('cleans up the object THIS run uploaded when the RPC fails afterward', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: null, error: { code: '42501' } },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1)
    expect(db.__mocks.remove).toHaveBeenCalledTimes(1)
    const [uploadPath] = db.__mocks.upload.mock.calls[0]
    const [[removedPaths]] = db.__mocks.remove.mock.calls
    expect(removedPaths).toEqual([uploadPath])
  })

  it("does NOT delete the uploaded object when a concurrent execution already persisted the message before this run's RPC call failed (race guard)", async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [
        { data: null, error: null },
        { data: { id: 'concurrent-winner' }, error: null },
      ],
      rpcResult: { data: null, error: { code: '40001' } },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1)
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })

  it('NEVER removes a pre-existing object (found via "already exists") even when the RPC fails afterward', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'Duplicate', statusCode: '409' },
      rpcResult: { data: null, error: { code: '42501' } },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })

  it('maps an RPC "duplicate" result to outcome duplicate without any cleanup', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: 'duplicate', error: null },
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'duplicate' })
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })
})

describe('persistInboundImageMessage — no secrets in outcome or logs', () => {
  it('the returned outcome never contains the instance token, base64 content, or storage path', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('test-instance-token')
    expect(serialized).not.toContain(VALID_JPEG_BASE64)
  })

  it('never logs the raw rpc error message, even when it contains sensitive-looking text', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const sensitiveMessage = 'token=SUPER_SECRET_TOKEN_VALUE leaked in error'
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: null, error: { code: '42501', message: sensitiveMessage } },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })
      const allLoggedText = errorSpy.mock.calls
        .flat()
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ')
      expect(allLoggedText).not.toContain('SUPER_SECRET_TOKEN_VALUE')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('persistInboundImageMessage — tenancy', () => {
  it('rejects when the resolved conversation belongs to a different account than expected', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({
      contactsQueue: [{ data: [], error: null }, { data: NEW_CONTACT_ROW, error: null }],
      conversationsQueue: [
        { data: [{ id: CONVERSATION_ID, account_id: OTHER_ACCOUNT_ID, contact_id: CONTACT_ID }], error: null },
      ],
      messagesQueue: [{ data: null, error: null }],
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'conversation_failed' })
    expect(downloadMock).not.toHaveBeenCalled()
  })
})

describe('persistInboundImageMessage — storage path safety', () => {
  it('refuses to build a storage path when accountId is not UUID-shaped', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const malformedAccountId = 'not-a-uuid'
    const db = createFakeDb({
      contactsQueue: [
        { data: [], error: null },
        { data: { id: CONTACT_ID, account_id: malformedAccountId, phone: '5591999999999' }, error: null },
      ],
      conversationsQueue: [
        { data: [], error: null },
        {
          data: { id: CONVERSATION_ID, account_id: malformedAccountId, contact_id: CONTACT_ID },
          error: null,
        },
      ],
      messagesQueue: [{ data: null, error: null }],
    })

    const result = await persistInboundImageMessage({
      db,
      accountId: malformedAccountId,
      configOwnerUserId: 'user-1',
      instanceToken: 'test-instance-token',
      parsed: baseParsed(),
    })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a path-traversal-shaped providerMessageId the same way as any other id (hashed, never interpolated raw)', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundImageMessage({
      db,
      ...ARGS_BASE,
      parsed: baseParsed({ providerMessageId: '../../../etc/passwd' }),
    })

    const [path] = db.__mocks.upload.mock.calls[0]
    expect(path).not.toContain('..')
    expect(path).not.toContain('etc/passwd')
    expect(path.startsWith(`${ACCOUNT_ID}/${CONVERSATION_ID}/`)).toBe(true)
  })
})

describe('persistInboundImageMessage — base64 format validation', () => {
  it('rejects a data-URI-prefixed base64Data instead of silently letting the decoder strip the prefix', async () => {
    downloadMock.mockResolvedValue({ base64Data: `data:image/jpeg;base64,${VALID_JPEG_BASE64}` })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects base64Data containing embedded whitespace/newlines instead of silently letting the decoder drop it', async () => {
    const withWhitespace = `${VALID_JPEG_BASE64.slice(0, 10)}\n${VALID_JPEG_BASE64.slice(10)}`
    downloadMock.mockResolvedValue({ base64Data: withWhitespace })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundImageMessage — metadata hygiene', () => {
  it('media_metadata sent to the RPC only ever contains width/height/captionPresent/decodedSize/format', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundImageMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const rpcArgs = db.__mocks.rpc.mock.calls[0][1]
    const metadataKeys = Object.keys(rpcArgs.p_media_metadata).map((k) => k.toLowerCase())
    expect(new Set(metadataKeys)).toEqual(
      new Set(['width', 'height', 'captionpresent', 'decodedsize', 'format']),
    )
    for (const forbidden of ['url', 'mediakey', 'directpath', 'filesha256', 'fileencsha256', 'token']) {
      expect(metadataKeys).not.toContain(forbidden)
    }
  })
})

describe('persistInboundImageMessage — LID never becomes a phone', () => {
  it('fails safely (contact_failed) instead of fabricating a contact when only an @lid sender/chatId is present', async () => {
    const db = createFakeDb()
    const parsed = baseParsed({
      sender: '208756952567854@lid',
      chatId: '208756952567854@lid',
      senderPn: undefined,
      chatPhone: undefined,
      chatWaChatid: undefined,
    })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed })

    expect(result).toEqual({ outcome: 'error', code: 'contact_failed' })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('resolves via senderPn when sender is an @lid JID', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_JPEG_BASE64, mimetype: 'image/jpeg' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })
    const parsed = baseParsed({ sender: '208756952567854@lid', senderPn: '5591999999999' })

    const result = await persistInboundImageMessage({ db, ...ARGS_BASE, parsed })

    expect(result).toEqual({ outcome: 'persisted' })
  })
})
