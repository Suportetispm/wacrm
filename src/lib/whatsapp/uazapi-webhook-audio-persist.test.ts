import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedInboundAudioMessage } from './uazapi-webhook-audio-parser'

vi.mock('./uazapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-api')>()
  return { ...actual, downloadMessageMedia: vi.fn() }
})

// Only the network fetch is replaced — isMp3Buffer and the error class
// stay real, so signature validation is exercised for real.
vi.mock('./uazapi-media-file-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uazapi-media-file-fetch')>()
  return { ...actual, fetchUazapiMediaFile: vi.fn() }
})

import { downloadMessageMedia, UazapiHttpError } from './uazapi-api'
import { fetchUazapiMediaFile, UazapiFileFetchError } from './uazapi-media-file-fetch'
import { persistInboundAudioMessage } from './uazapi-webhook-audio-persist'

const downloadMock = vi.mocked(downloadMessageMedia)
const fileFetchMock = vi.mocked(fetchUazapiMediaFile)

const FILE_URL = 'https://fixture.uazapi.test/files/converted.mp3'

function id3Mp3(filler = 200): Buffer {
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x04, 0x00, 0x00]), Buffer.alloc(filler, 0x11)])
}
function frameMp3(filler = 200): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(filler, 0x22)])
}

interface TableResponse {
  data: unknown
  error: unknown
}

function makeChainable(response: TableResponse, record: (op: 'insert' | 'update', payload: unknown) => void) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  for (const m of ['select', 'eq', 'like', 'order', 'limit', 'is']) builder[m] = chain
  builder.insert = (payload: unknown) => {
    record('insert', payload)
    return builder
  }
  builder.update = (payload: unknown) => {
    record('update', payload)
    return builder
  }
  builder.single = async () => response
  builder.maybeSingle = async () => response
  builder.then = (resolve: (v: TableResponse) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return builder
}

function createFakeDb(opts: {
  contactsQueue?: TableResponse[]
  conversationsQueue?: TableResponse[]
  messagesQueue?: TableResponse[]
  rpcResult?: TableResponse
  uploadError?: unknown
} = {}) {
  const queues: Record<string, TableResponse[]> = {
    contacts: opts.contactsQueue ? [...opts.contactsQueue] : [{ data: [], error: null }],
    conversations: opts.conversationsQueue ? [...opts.conversationsQueue] : [{ data: [], error: null }],
    messages: opts.messagesQueue ? [...opts.messagesQueue] : [{ data: null, error: null }],
  }
  const writes: { table: string; op: string; payload: unknown }[] = []
  const upload = vi.fn(async () => ({ data: opts.uploadError ? null : { path: 'x' }, error: opts.uploadError ?? null }))
  const remove = vi.fn(async () => ({ data: {}, error: null }))
  const rpc = vi.fn(async () => opts.rpcResult ?? { data: 'persisted', error: null })
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      const queue = queues[table]
      const response = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null }
      return makeChainable(response, (op, payload) => writes.push({ table, op, payload }))
    },
    rpc,
    storage: { from: () => ({ upload, remove }) },
    __mocks: { upload, remove, rpc },
    __writes: writes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111'
const CONTACT_ID = '22222222-2222-2222-2222-222222222222'
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333'
const OTHER_ACCOUNT_ID = '99999999-9999-9999-9999-999999999999'

const NEW_CONTACT_ROW = { id: CONTACT_ID, account_id: ACCOUNT_ID, phone: '5591999999999' }
const NEW_CONVERSATION_ROW = { id: CONVERSATION_ID, account_id: ACCOUNT_ID, contact_id: CONTACT_ID }

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

function baseParsed(overrides: Partial<ParsedInboundAudioMessage> = {}): ParsedInboundAudioMessage {
  return {
    providerMessageId: 'dedup-id-123',
    providerDownloadId: 'download-id-456',
    chatId: '5591999999999@s.whatsapp.net',
    sender: '5591999999999@s.whatsapp.net',
    senderName: 'Cliente Teste',
    occurredAt: new Date('2026-01-01T12:00:00Z').toISOString(),
    isVoiceNote: true,
    durationSeconds: 3,
    sourceMimeType: 'audio/ogg',
    ...overrides,
  }
}

const ARGS_BASE = {
  accountId: ACCOUNT_ID,
  configOwnerUserId: 'user-1',
  instanceToken: 'test-instance-token',
  whatsappConfigId: '44444444-4444-4444-4444-444444444444',
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  downloadMock.mockReset()
  fileFetchMock.mockReset()
  downloadMock.mockResolvedValue({ fileUrl: FILE_URL, mimetype: 'audio/mpeg' })
  fileFetchMock.mockResolvedValue({ buffer: id3Mp3(), contentType: 'audio/mpeg' })
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('persistInboundAudioMessage — happy path', () => {
  it('asks /message/download for an MP3 fileURL (generate_mp3=true, no base64, no transcription) using message.id', async () => {
    const db = createFakeDb(freshEntityQueues())
    await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })

    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(downloadMock).toHaveBeenCalledWith({
      instanceToken: 'test-instance-token',
      id: 'download-id-456',
      generateMp3: true,
      returnBase64: false,
      transcribe: false,
    })
    expect(fileFetchMock).toHaveBeenCalledWith(expect.objectContaining({ fileUrl: FILE_URL }))
  })

  it('uploads a validated ID3 MP3 to the private bucket and persists content_type=audio via the RPC', async () => {
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })

    expect(result).toEqual({ outcome: 'persisted', contactId: CONTACT_ID, conversationId: CONVERSATION_ID })

    const [path, buffer, uploadOpts] = db.__mocks.upload.mock.calls[0]
    expect(path).toMatch(new RegExp(`^${ACCOUNT_ID}/${CONVERSATION_ID}/[0-9a-f]{64}\\.mp3$`))
    expect(path).not.toContain('dedup-id-123')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(uploadOpts).toMatchObject({ contentType: 'audio/mpeg', upsert: false })

    expect(db.__mocks.rpc).toHaveBeenCalledWith('uazapi_persist_inbound_audio_message', {
      p_account_id: ACCOUNT_ID,
      p_conversation_id: CONVERSATION_ID,
      p_message_id: 'dedup-id-123',
      p_content_text: '[audio]',
      p_occurred_at: '2026-01-01T12:00:00.000Z',
      p_media_storage_path: path,
      p_media_file_name: 'audio.mp3',
      p_media_mime_type: 'audio/mpeg',
      p_media_file_size: id3Mp3().length,
      p_media_metadata: {
        format: 'mp3',
        decodedSize: id3Mp3().length,
        voiceNote: true,
        sourceMimeType: 'audio/ogg',
        durationSeconds: 3,
      },
    })
  })

  it('accepts a raw MPEG-frame MP3 (no ID3 tag)', async () => {
    fileFetchMock.mockResolvedValue({ buffer: frameMp3(), contentType: 'audio/mpeg' })
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result.outcome).toBe('persisted')
  })

  it('the same providerMessageId always maps to the same storage path (redelivery-safe)', async () => {
    const db1 = createFakeDb(freshEntityQueues())
    const db2 = createFakeDb(freshEntityQueues())
    await persistInboundAudioMessage({ ...ARGS_BASE, db: db1, parsed: baseParsed() })
    await persistInboundAudioMessage({ ...ARGS_BASE, db: db2, parsed: baseParsed() })
    expect(db1.__mocks.upload.mock.calls[0][0]).toBe(db2.__mocks.upload.mock.calls[0][0])
  })
})

describe('persistInboundAudioMessage — deduplication', () => {
  it('a known duplicate short-circuits before any download/upload/RPC', async () => {
    const db = createFakeDb({
      ...freshEntityQueues(),
      messagesQueue: [{ data: { id: 'existing-row' }, error: null }],
    })
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'duplicate', contactId: CONTACT_ID, conversationId: CONVERSATION_ID })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('an RPC "duplicate" (concurrent delivery) is passed through, and the shared object is never deleted', async () => {
    const db = createFakeDb({ ...freshEntityQueues(), rpcResult: { data: 'duplicate', error: null } })
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result.outcome).toBe('duplicate')
    expect(db.__mocks.remove).not.toHaveBeenCalled()
  })

  it('a pre-existing storage object (retry/race) is not an error', async () => {
    const db = createFakeDb({ ...freshEntityQueues(), uploadError: { message: 'The resource already exists', statusCode: '409' } })
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result.outcome).toBe('persisted')
  })
})

describe('persistInboundAudioMessage — rejection of invalid files', () => {
  it('rejects HTML disguised as audio (real signature check)', async () => {
    fileFetchMock.mockResolvedValue({ buffer: Buffer.from('<!DOCTYPE html><html>error</html>'), contentType: 'audio/mpeg' })
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects an OGG file when MP3 was requested', async () => {
    fileFetchMock.mockResolvedValue({ buffer: Buffer.from('OggS\x00\x02\x00\x00', 'binary'), contentType: 'audio/mpeg' })
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
  })

  it('rejects when UAZAPI declares a non-MP3 mimetype for the converted file', async () => {
    downloadMock.mockResolvedValue({ fileUrl: FILE_URL, mimetype: 'audio/ogg' })
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'validation_failed' })
    expect(fileFetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when /message/download returns no fileURL (never falls back to content.URL)', async () => {
    downloadMock.mockResolvedValue({ mimetype: 'audio/mpeg' })
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
    expect(fileFetchMock).not.toHaveBeenCalled()
  })

  it('maps a UAZAPI HTTP error on /message/download to download_failed', async () => {
    downloadMock.mockRejectedValue(new UazapiHttpError(500, 'boom'))
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'download_failed' })
  })

  it.each([
    ['url_not_allowed', 'validation_failed'],
    ['content_type_refused', 'validation_failed'],
    ['too_large', 'validation_failed'],
    ['empty', 'validation_failed'],
    ['http_error', 'download_failed'],
    ['redirect_refused', 'download_failed'],
    ['timeout', 'download_failed'],
  ] as const)('maps a file-fetch "%s" failure to %s, never uploading', async (fetchCode, outcomeCode) => {
    fileFetchMock.mockRejectedValue(new UazapiFileFetchError(fetchCode))
    const db = createFakeDb(freshEntityQueues())
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: outcomeCode })
    expect(db.__mocks.upload).not.toHaveBeenCalled()
  })
})

describe('persistInboundAudioMessage — tenancy, cleanup and logging', () => {
  it('account isolation: a conversation resolved for another account is rejected before any download', async () => {
    const db = createFakeDb({
      contactsQueue: freshEntityQueues().contactsQueue,
      conversationsQueue: [
        { data: [], error: null },
        { data: { ...NEW_CONVERSATION_ROW, account_id: OTHER_ACCOUNT_ID }, error: null },
      ],
    })
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'conversation_failed' })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(db.__mocks.rpc).not.toHaveBeenCalled()
  })

  it('new conversations are created with the route-resolved whatsapp_config_id (078B)', async () => {
    const db = createFakeDb(freshEntityQueues())
    await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    const convInsert = db.__writes.find((w: { table: string; op: string }) => w.table === 'conversations' && w.op === 'insert')
    expect(convInsert.payload).toMatchObject({ account_id: ACCOUNT_ID, whatsapp_config_id: ARGS_BASE.whatsappConfigId })
  })

  it('an RPC failure removes the object this run uploaded (no orphan) and reports database_failed', async () => {
    const db = createFakeDb({ ...freshEntityQueues(), rpcResult: { data: null, error: { code: 'PGRST202' } } })
    const result = await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    expect(result).toEqual({ outcome: 'error', code: 'database_failed' })
    expect(db.__mocks.remove).toHaveBeenCalledTimes(1)
  })

  it('never logs the file URL, token, phone, name or message ids', async () => {
    fileFetchMock.mockRejectedValue(new UazapiFileFetchError('http_error'))
    const db = createFakeDb({ ...freshEntityQueues() })
    await persistInboundAudioMessage({ ...ARGS_BASE, db, parsed: baseParsed() })
    const logged = JSON.stringify(consoleErrorSpy.mock.calls)
    for (const secret of [FILE_URL, 'test-instance-token', '5591999999999', 'Cliente Teste', 'dedup-id-123', 'download-id-456']) {
      expect(logged).not.toContain(secret)
    }
  })
})
