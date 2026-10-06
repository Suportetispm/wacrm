import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Contact } from '@/types'
import {
  applyAvatarSyncResults,
  applyAvatarSyncResultsToContact,
  createAvatarSyncQueue,
  selectAvatarSyncCandidates,
  type AvatarSyncSender,
} from './avatar-sync-queue'
import {
  AVATAR_RECHECK_INTERVAL_MS,
  AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST,
  avatarVersionFromPath,
  isAvatarCheckDue,
  type AvatarSyncResponse,
  type AvatarSyncResult,
} from './contact-avatar-sync-shared'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const CONFIG = 'cfg-1'

function contact(id: string, extra: Partial<Contact> = {}): Contact {
  return {
    id,
    user_id: 'u',
    account_id: 'acc',
    phone: '5591999990000',
    created_at: '',
    updated_at: '',
    whatsapp_avatar_path: null,
    whatsapp_avatar_checked_at: null,
    ...extra,
  }
}

function conversation(id: string, c: Contact | undefined, configId: string | null = CONFIG): Conversation {
  return {
    id,
    user_id: 'u',
    contact_id: c?.id ?? 'none',
    status: 'in_progress',
    unread_count: 0,
    created_at: '',
    updated_at: '',
    contact: c,
    whatsapp_config_id: configId,
  } as Conversation
}

const okResponse = (ids: string[], extra: Partial<AvatarSyncResponse> = {}): { ok: true; response: AvatarSyncResponse } => ({
  ok: true,
  response: {
    throttled: false,
    results: ids.map((conversationId) => ({ conversationId, contactId: `contact-of-${conversationId}`, status: 'updated', avatar: null })),
    ...extra,
  },
})

/** A sender whose calls resolve only when the test releases them — exposes concurrency. */
function controlledSender() {
  const calls: { ids: string[]; resolve: (v: Awaited<ReturnType<AvatarSyncSender>>) => void }[] = []
  let inFlight = 0
  let maxInFlight = 0
  const send: AvatarSyncSender = (ids) =>
    new Promise((resolve) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      calls.push({
        ids,
        resolve: (v) => {
          inFlight--
          resolve(v)
        },
      })
    })
  return { send, calls, maxInFlight: () => maxInFlight }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('shared helpers', () => {
  it('7-day re-check: never checked or older than the interval is due; recent is not', () => {
    expect(isAvatarCheckDue(null, NOW)).toBe(true)
    expect(isAvatarCheckDue(new Date(NOW - AVATAR_RECHECK_INTERVAL_MS).toISOString(), NOW)).toBe(true)
    expect(isAvatarCheckDue(new Date(NOW - AVATAR_RECHECK_INTERVAL_MS + 1000).toISOString(), NOW)).toBe(false)
  })

  it('version is an opaque content-hash prefix, never the path', () => {
    const hash = 'ef'.repeat(32)
    expect(avatarVersionFromPath(`acc/contacts/c/${hash}.webp`)).toBe(hash.slice(0, 16))
    expect(avatarVersionFromPath('acc/contacts/c/not-a-hash.jpg')).toBeNull()
    expect(avatarVersionFromPath(null)).toBeNull()
  })
})

describe('selectAvatarSyncCandidates', () => {
  it('old conversations never checked (or stale) are eligible; a recent check, a missing connection or contact are not', () => {
    const list = [
      conversation('never', contact('c1')),
      conversation('stale', contact('c2', { whatsapp_avatar_checked_at: new Date(NOW - AVATAR_RECHECK_INTERVAL_MS - 1).toISOString() })),
      conversation('recent', contact('c3', { whatsapp_avatar_path: 'x', whatsapp_avatar_checked_at: new Date(NOW - 1000).toISOString() })),
      conversation('no-config', contact('c4'), null),
      conversation('no-contact', undefined),
      conversation('no-phone', contact('c5', { phone: '' })),
    ]
    expect(selectAvatarSyncCandidates(list, NOW).map((c) => c.id)).toEqual(['never', 'stale'])
  })
})

describe('createAvatarSyncQueue', () => {
  it('sends sequential batches of the internal limit, never more than one request at a time', async () => {
    const s = controlledSender()
    const onResults = vi.fn()
    const queue = createAvatarSyncQueue({ send: s.send, onResults, now: () => NOW })
    const list = Array.from({ length: 12 }, (_, i) => conversation(`v${i}`, contact(`c${i}`)))
    queue.enqueue(list)
    await flush()

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].ids).toHaveLength(AVATAR_SYNC_MAX_CONVERSATIONS_PER_REQUEST)
    s.calls[0].resolve(okResponse(s.calls[0].ids))
    await flush()
    expect(s.calls).toHaveLength(2)
    s.calls[1].resolve(okResponse(s.calls[1].ids))
    await flush()
    expect(s.calls).toHaveLength(3)
    expect(s.calls[2].ids).toHaveLength(2)
    s.calls[2].resolve(okResponse(s.calls[2].ids))
    await flush()

    expect(s.maxInFlight()).toBe(1)
    expect(s.calls.flatMap((c) => c.ids)).toEqual(list.map((c) => c.id))
    expect(onResults).toHaveBeenCalledTimes(3)
  })

  it('stored photos with a recent check never trigger a request', async () => {
    const send = vi.fn<AvatarSyncSender>()
    const queue = createAvatarSyncQueue({ send, onResults: vi.fn(), now: () => NOW })
    queue.enqueue([conversation('v', contact('c', { whatsapp_avatar_path: 'p', whatsapp_avatar_checked_at: new Date(NOW).toISOString() }))])
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('dedup: re-renders / list refetches / filter changes re-enqueue the same conversations — no repeat request', async () => {
    const send = vi.fn<AvatarSyncSender>(async (ids) => okResponse(ids))
    const queue = createAvatarSyncQueue({ send, onResults: vi.fn(), now: () => NOW })
    const list = [conversation('v1', contact('c1')), conversation('v2', contact('c2'))]
    queue.enqueue(list)
    queue.enqueue(list) // re-render
    queue.enqueue([list[1]]) // filtered subset
    queue.enqueue(list.map((c) => ({ ...c }))) // refetch: new objects, same ids
    await flush()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toEqual(['v1', 'v2'])
  })

  it('two conversations of the same contact: requested once', async () => {
    const send = vi.fn<AvatarSyncSender>(async (ids) => okResponse(ids))
    const queue = createAvatarSyncQueue({ send, onResults: vi.fn(), now: () => NOW })
    queue.enqueue([conversation('v1', contact('same')), conversation('v2', contact('same'))])
    await flush()
    expect(send.mock.calls[0][0]).toEqual(['v1'])
  })

  it('throttled response: results applied, queue stops for good (no automatic retry)', async () => {
    const send = vi.fn<AvatarSyncSender>(async (ids) => okResponse(ids, { throttled: true }))
    const onResults = vi.fn()
    const queue = createAvatarSyncQueue({ send, onResults, now: () => NOW })
    queue.enqueue(Array.from({ length: 8 }, (_, i) => conversation(`v${i}`, contact(`c${i}`))))
    await flush()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(onResults).toHaveBeenCalledTimes(1)
    expect(queue.stopped).toBe(true)
    queue.enqueue([conversation('later', contact('new'))])
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['HTTP 429', { ok: false as const, throttled: true }],
    ['other failure', { ok: false as const, throttled: false }],
  ])('%s: queue stops, nothing applied', async (_label, failure) => {
    const send = vi.fn<AvatarSyncSender>(async () => failure)
    const onResults = vi.fn()
    const queue = createAvatarSyncQueue({ send, onResults, now: () => NOW })
    queue.enqueue(Array.from({ length: 8 }, (_, i) => conversation(`v${i}`, contact(`c${i}`))))
    await flush()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(onResults).not.toHaveBeenCalled()
    expect(queue.stopped).toBe(true)
  })

  it('a thrown network error also stops the queue', async () => {
    const send = vi.fn<AvatarSyncSender>(async () => {
      throw new Error('offline')
    })
    const queue = createAvatarSyncQueue({ send, onResults: vi.fn(), now: () => NOW })
    queue.enqueue(Array.from({ length: 8 }, (_, i) => conversation(`v${i}`, contact(`c${i}`))))
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.stopped).toBe(true)
  })

  it('dispose (unmount): a response landing afterwards is ignored and nothing else is sent', async () => {
    const s = controlledSender()
    const onResults = vi.fn()
    const queue = createAvatarSyncQueue({ send: s.send, onResults, now: () => NOW })
    queue.enqueue(Array.from({ length: 8 }, (_, i) => conversation(`v${i}`, contact(`c${i}`))))
    await flush()
    queue.dispose()
    s.calls[0].resolve(okResponse(s.calls[0].ids))
    await flush()
    expect(onResults).not.toHaveBeenCalled()
    expect(s.calls).toHaveLength(1)
  })

  it('uses no timers (no polling)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const send = vi.fn<AvatarSyncSender>(async (ids) => okResponse(ids))
    const queue = createAvatarSyncQueue({ send, onResults: vi.fn(), now: () => NOW })
    setTimeoutSpy.mockClear()
    queue.enqueue([conversation('v1', contact('c1'))])
    await Promise.resolve()
    await Promise.resolve()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
    setIntervalSpy.mockRestore()
  })
})

describe('applyAvatarSyncResults', () => {
  const result = (contactId: string, version: string | null): AvatarSyncResult => ({
    conversationId: 'any',
    contactId,
    status: 'updated',
    avatar: { version, checkedAt: '2026-10-06T12:00:00.000Z' },
  })

  it('updates EVERY conversation of the returned contact, leaves others untouched', () => {
    const shared = contact('shared')
    const other = contact('other')
    const list = [conversation('v1', shared), conversation('v2', other), conversation('v3', { ...shared })]
    const next = applyAvatarSyncResults(list, [result('shared', '0123456789abcdef')])
    expect(next[0].contact?.whatsapp_avatar_version).toBe('0123456789abcdef')
    expect(next[2].contact?.whatsapp_avatar_version).toBe('0123456789abcdef')
    expect(next[0].contact?.whatsapp_avatar_checked_at).toBe('2026-10-06T12:00:00.000Z')
    expect(next[1]).toBe(list[1])
  })

  it('returns the same array when nothing changed (no re-render loop)', () => {
    const list = [conversation('v1', contact('c1'))]
    expect(applyAvatarSyncResults(list, [])).toBe(list)
    const once = applyAvatarSyncResults(list, [result('c1', null)])
    expect(applyAvatarSyncResults(once, [result('c1', null)])).toBe(once)
  })

  it('patches the separately-held active contact too', () => {
    const active = contact('c1')
    expect(applyAvatarSyncResultsToContact(active, [result('c1', 'aaaaaaaaaaaaaaaa')])?.whatsapp_avatar_version).toBe('aaaaaaaaaaaaaaaa')
    expect(applyAvatarSyncResultsToContact(active, [result('other', 'aaaaaaaaaaaaaaaa')])).toBe(active)
    expect(applyAvatarSyncResultsToContact(null, [result('c1', null)])).toBeNull()
  })
})
