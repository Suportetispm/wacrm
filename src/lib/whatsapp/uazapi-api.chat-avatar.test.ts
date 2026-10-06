import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getChatAvatar, UazapiHttpError } from './uazapi-api'

const SERVER = 'https://fixture.uazapi.test'
const TOKEN = 'fixture-instance-token'
const CHAT_ID = '5591999999999@s.whatsapp.net'

const fetchMock = vi.fn()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.stubEnv('UAZAPI_SERVER_URL', SERVER)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('getChatAvatar — POST /chat/avatar', () => {
  it('defaults to { number, preview: true } with the instance token header and no force', async () => {
    fetchMock.mockResolvedValue(json({ url: 'https://pps.whatsapp.net/v/t61/x.jpg?oh=1' }))

    await getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${SERVER}/chat/avatar`)
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe(TOKEN)
    const body = JSON.parse(init.body)
    expect(body).toEqual({ number: CHAT_ID, preview: true })
    expect(body.preview).toBe(true)
    expect(body).not.toHaveProperty('force')
  })

  it('sends preview: true when asked explicitly (what the contact-avatar sync does), still without force', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))

    await getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID, preview: true })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ number: CHAT_ID, preview: true })
    expect(body.preview).toBe(true)
    expect(body).not.toHaveProperty('force')
  })

  it('returns the URL when present', async () => {
    fetchMock.mockResolvedValue(json({ url: 'https://pps.whatsapp.net/v/t61/x.jpg?oh=1' }))
    await expect(getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID })).resolves.toEqual({
      url: 'https://pps.whatsapp.net/v/t61/x.jpg?oh=1',
    })
  })

  it('treats url "" (no photo) as a valid answer, not an error', async () => {
    fetchMock.mockResolvedValue(json({ url: '' }))
    await expect(getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID })).resolves.toEqual({ url: '' })
  })

  it('a missing or non-string url is normalized to ""', async () => {
    fetchMock.mockResolvedValue(json({}))
    await expect(getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID })).resolves.toEqual({ url: '' })
    fetchMock.mockResolvedValue(json({ url: 123 }))
    await expect(getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID })).resolves.toEqual({ url: '' })
  })

  it.each([400, 401, 429, 500])('HTTP %i throws UazapiHttpError with the real status', async (status) => {
    fetchMock.mockResolvedValue(json({ error: 'x' }, status))
    const err = await getChatAvatar({ instanceToken: TOKEN, number: CHAT_ID }).catch((e) => e)
    expect(err).toBeInstanceOf(UazapiHttpError)
    expect((err as UazapiHttpError).status).toBe(status)
  })
})
