import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedInboundDocumentMessage } from './uazapi-webhook-document-parser'

vi.mock('./uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-api')>()
  return {
    ...actual,
    downloadMessageMedia: vi.fn(),
  }
})

import { downloadMessageMedia, UazapiHttpError } from './uazapi-api'
import { persistInboundDocumentMessage } from './uazapi-webhook-document-persist'

const downloadMock = vi.mocked(downloadMessageMedia)

const TWENTY_MB = 20 * 1024 * 1024

function base64CharsForDecodedBytes(decodedBytes: number): number {
  return Math.ceil((decodedBytes * 4) / 3 / 4) * 4
}

const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4 fake pdf content for testing purposes only').toString(
  'base64',
)
const NOT_A_PDF_BASE64 = Buffer.from('this is definitely not a pdf file').toString('base64')

interface TableResponse {
  data: unknown
  error: unknown
}

// Minimal fake Supabase query-builder: every chain method returns
// itself; `.single()`/`.maybeSingle()`/awaiting the builder directly
// all resolve to the next queued response for that table. Good enough
// to drive both `uazapi-webhook-document-persist.ts` and the real
// `findExistingContact` helper it calls (from `@/lib/contacts/dedupe`)
// without needing to fake full Postgres semantics.
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- fake bucket router; the module only ever uses one bucket, so the name isn't asserted on
      from(bucket: string) {
        return { upload, remove }
      },
    },
    __mocks: { upload, remove, rpc },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function baseParsed(overrides: Partial<ParsedInboundDocumentMessage> = {}): ParsedInboundDocumentMessage {
  return {
    providerMessageId: 'dedup-id-123',
    providerDownloadId: 'download-id-456',
    chatId: '5591999999999@s.whatsapp.net',
    sender: '5591999999999@s.whatsapp.net',
    senderName: 'Cliente Teste',
    occurredAt: new Date('2026-01-01T12:00:00Z').toISOString(),
    fileName: 'invoice.pdf',
    mimeType: 'application/pdf',
    fileSize: 12345,
    pageCount: 3,
    caption: undefined,
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
      { data: [], error: null }, // findExistingContact: no match
      { data: NEW_CONTACT_ROW, error: null }, // insert().select().single()
    ],
    conversationsQueue: [
      { data: [], error: null }, // find existing: none
      { data: NEW_CONVERSATION_ROW, error: null }, // insert().select().single()
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

describe('persistInboundDocumentMessage — happy path', () => {
  it('downloads, validates, uploads, and persists a valid PDF', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64, mimetype: 'application/pdf' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({
      db,
      ...ARGS_BASE,
      parsed: baseParsed(),
    })

    expect(result).toEqual({ outcome: 'persisted' })
    expect(downloadMock).toHaveBeenCalledWith({
      instanceToken: 'test-instance-token',
      id: 'download-id-456',
      returnBase64: true,
    })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1)
    expect(db.__mocks.rpc).toHaveBeenCalledTimes(1)
    const rpcArgs = db.__mocks.rpc.mock.calls[0][1]
    expect(rpcArgs.p_conversation_id).toBe(CONVERSATION_ID)
    expect(rpcArgs.p_message_id).toBe('dedup-id-123')
    expect(rpcArgs.p_media_mime_type).toBe('application/pdf')
    expect(rpcArgs.p_media_metadata).toEqual({ pageCount: 3 })
  })

  it('uses a deterministic path derived from accountId/conversationId/providerMessageId (never the raw filename or a random id)', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const [path] = db.__mocks.upload.mock.calls[0]
    expect(path.startsWith(`${ACCOUNT_ID}/${CONVERSATION_ID}/`)).toBe(true)
    expect(path.endsWith('.pdf')).toBe(true)
    expect(path).not.toContain('invoice')
    expect(path).not.toContain('dedup-id-123')
  })
})

describe('persistInboundDocumentMessage — known duplicate (no new upload)', () => {
  it('returns duplicate without ever calling downloadMessageMedia or uploading, when the message is already persisted', async () => {
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: { id: 'existing-message-id' }, error: null }],
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'duplicate' })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — file validation', () => {
  it('rejects when downloadMessageMedia returns no base64Data (fails closed, never falls back to fileUrl)', async () => {
    downloadMock.mockResolvedValue({ fileUrl: 'https://uazapi.example/file.pdf' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a download failure (UazapiHttpError) as download_failed', async () => {
    downloadMock.mockRejectedValue(new UazapiHttpError(404, 'Message not found'))
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
  })

  it('rejects content whose signature is not PDF ("assinatura não PDF")', async () => {
    downloadMock.mockResolvedValue({ base64Data: NOT_A_PDF_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects garbage/invalid base64 content the same way (decodes to non-PDF bytes)', async () => {
    downloadMock.mockResolvedValue({ base64Data: '####not-valid-base64####' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
  })

  it('rejects a mimetype mismatch even when the signature looks like PDF', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64, mimetype: 'application/zip' })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects a decoded file above the 20 MB limit before ever calling Buffer.from on it (defense in depth, independent of the wrapper)', async () => {
    const oversizedBase64 = 'A'.repeat(base64CharsForDecodedBytes(TWENTY_MB + 1000))
    downloadMock.mockResolvedValue({ base64Data: oversizedBase64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — upload failures', () => {
  it('returns upload_failed and never calls the RPC when the upload fails for a reason other than "already exists"', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'Network error', statusCode: '500' },
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'upload_failed' })
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('treats an "already exists" upload error as informational and still proceeds to the RPC', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'The resource already exists', statusCode: '409' },
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'persisted' })
    expect(db.__mocks.rpc).toHaveBeenCalledTimes(1)
  })
})

describe('persistInboundDocumentMessage — RPC failure and cleanup', () => {
  it('cleans up the object THIS run uploaded when the RPC fails afterward', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: null, error: { code: '42501' } },
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1)
    expect(db.__mocks.remove).toHaveBeenCalledTimes(1)
    const [uploadPath] = db.__mocks.upload.mock.calls[0]
    const [[removedPaths]] = db.__mocks.remove.mock.calls
    expect(removedPaths).toEqual([uploadPath])
  })

  it("does NOT delete the uploaded object when a concurrent execution already persisted the message before this run's RPC call failed (race guard)", async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [
        { data: null, error: null }, // initial pre-check: not found yet
        { data: { id: 'concurrent-winner' }, error: null }, // race re-check: a concurrent execution won in between
      ],
      rpcResult: { data: null, error: { code: '40001' } }, // THIS run's own RPC call genuinely fails
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.upload).toHaveBeenCalledTimes(1) // this run did create the object
    expect(db.__mocks.remove).not.toHaveBeenCalled() // but must not delete it — a concurrent message now references it
  })

  it('NEVER removes a pre-existing object (found via "already exists") even when the RPC fails afterward', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      uploadError: { message: 'Duplicate', statusCode: '409' },
      rpcResult: { data: null, error: { code: '42501' } },
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })

  it('maps an RPC "duplicate" result to outcome duplicate without any cleanup', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: 'duplicate', error: null },
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'duplicate' })
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — no secrets in outcome', () => {
  it('the returned outcome never contains the instance token, base64 content, or storage path', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('test-instance-token')
    expect(serialized).not.toContain(VALID_PDF_BASE64)
  })

  it('never logs the raw rpc error message, even when it contains sensitive-looking text', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const sensitiveMessage = 'token=SUPER_SECRET_TOKEN_VALUE leaked in error'
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: null, error: null }],
      rpcResult: { data: null, error: { code: '42501', message: sensitiveMessage } },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })
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

describe('persistInboundDocumentMessage — tenancy', () => {
  it('rejects when the resolved conversation belongs to a different account than expected (defense-in-depth beyond the scoped find-or-create query)', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({
      contactsQueue: [{ data: [], error: null }, { data: NEW_CONTACT_ROW, error: null }],
      conversationsQueue: [
        { data: [{ id: CONVERSATION_ID, account_id: OTHER_ACCOUNT_ID, contact_id: CONTACT_ID }], error: null },
      ],
      messagesQueue: [{ data: null, error: null }],
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'conversation_failed' })
    expect(downloadMock).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — storage path safety', () => {
  it('refuses to build a storage path when accountId is not UUID-shaped, even if it matches the resolved conversation.account_id', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
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

    const result = await persistInboundDocumentMessage({
      db,
      accountId: malformedAccountId,
      configOwnerUserId: 'user-1',
      instanceToken: 'test-instance-token',
      parsed: baseParsed(),
    })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — base64 format validation', () => {
  it('rejects a data-URI-prefixed base64Data instead of silently letting the decoder strip the prefix', async () => {
    downloadMock.mockResolvedValue({ base64Data: `data:application/pdf;base64,${VALID_PDF_BASE64}` })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects base64Data containing embedded whitespace/newlines instead of silently letting the decoder drop it', async () => {
    const withWhitespace = `${VALID_PDF_BASE64.slice(0, 10)}\n${VALID_PDF_BASE64.slice(10)}`
    downloadMock.mockResolvedValue({ base64Data: withWhitespace })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundDocumentMessage — metadata hygiene', () => {
  it('media_metadata sent to the RPC never contains url/mediaKey/hash-like keys', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })

    await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed: baseParsed() })

    const rpcArgs = db.__mocks.rpc.mock.calls[0][1]
    const metadataKeys = Object.keys(rpcArgs.p_media_metadata).map((k) => k.toLowerCase())
    for (const forbidden of ['url', 'mediakey', 'directpath', 'filesha256', 'fileencsha256', 'token']) {
      expect(metadataKeys).not.toContain(forbidden)
    }
  })
})

describe('persistInboundDocumentMessage — LID never becomes a phone', () => {
  it('fails safely (contact_failed) instead of fabricating a contact when only an @lid sender/chatId is present', async () => {
    const db = createFakeDb()
    const parsed = baseParsed({
      sender: '208756952567854@lid',
      chatId: '208756952567854@lid',
      senderPn: undefined,
      chatPhone: undefined,
      chatWaChatid: undefined,
    })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed })

    expect(result).toEqual({ outcome: 'error', code: 'contact_failed' })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('resolves via senderPn when sender is an @lid JID', async () => {
    downloadMock.mockResolvedValue({ base64Data: VALID_PDF_BASE64 })
    const db = createFakeDb({ ...freshEntityQueues(), messagesQueue: [{ data: null, error: null }] })
    const parsed = baseParsed({ sender: '208756952567854@lid', senderPn: '5591999999999' })

    const result = await persistInboundDocumentMessage({ db, ...ARGS_BASE, parsed })

    expect(result).toEqual({ outcome: 'persisted' })
  })
})
