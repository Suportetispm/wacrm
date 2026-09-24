import { beforeEach, describe, expect, it, vi } from 'vitest'

// ETAPA 077A — this module is the one place that resolves "the
// account's whatsapp_config row" without assuming there's exactly
// one. These tests simulate accounts with 0, 1, and 2+ rows (the
// UNIQUE(account_id) constraint still guarantees ≤1 in production
// today, but the code must already behave correctly once that
// constraint is lifted — see the module header for the rationale).

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  isLegacyFormat: vi.fn(),
}))

vi.mock('./encryption', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
  isLegacyFormat: mocks.isLegacyFormat,
}))

import { loadActiveWhatsAppConfig, loadPrimaryWhatsAppConfigRow } from './active-config'

/** Chainable `.select(cols).eq(...).order(...)` mock resolving to
 *  `{ data: rows, error }` — matches the exact shape
 *  `loadPrimaryWhatsAppConfigRow` calls (no `.single()`/`.maybeSingle()`
 *  anywhere in the chain). `updateSpy`/`updateEqSpy`, if provided, wire
 *  up `.update(payload).eq('id', ...)` for the legacy-token-upgrade
 *  path so a test can assert both the payload and exactly which
 *  column/value the write is scoped by. */
function supabaseStub(
  rows: Record<string, unknown>[] | null,
  opts: { error?: unknown; updateSpy?: (payload: unknown) => void; updateEqSpy?: (col: string, val: unknown) => void } = {},
) {
  const selectBuilder: Record<string, unknown> = {}
  selectBuilder.eq = vi.fn(() => selectBuilder)
  selectBuilder.order = vi.fn(async () => ({ data: rows, error: opts.error ?? null }))

  const updateBuilder: Record<string, unknown> = {}
  updateBuilder.eq = vi.fn((col: string, val: unknown) => {
    opts.updateEqSpy?.(col, val)
    return updateBuilder
  })
  updateBuilder.then = (resolve: (v: { error: null }) => void) => resolve({ error: null })

  return {
    from: vi.fn(() => ({
      select: vi.fn(() => selectBuilder),
      update: vi.fn((payload: unknown) => {
        opts.updateSpy?.(payload)
        return updateBuilder
      }),
    })),
  }
}

beforeEach(() => {
  mocks.decrypt.mockReset()
  mocks.encrypt.mockReset()
  mocks.isLegacyFormat.mockReset()
  mocks.decrypt.mockImplementation((v: string) => `decrypted:${v}`)
  mocks.encrypt.mockImplementation((v: string) => `encrypted:${v}`)
  mocks.isLegacyFormat.mockReturnValue(false)
})

describe('loadPrimaryWhatsAppConfigRow', () => {
  it('returns null when the account has no rows', async () => {
    const db = supabaseStub([]) as never
    const row = await loadPrimaryWhatsAppConfigRow(db, 'acct-1')
    expect(row).toBeNull()
  })

  it('returns null on a query error instead of throwing', async () => {
    const db = supabaseStub(null, { error: { message: 'boom' } }) as never
    const row = await loadPrimaryWhatsAppConfigRow(db, 'acct-1')
    expect(row).toBeNull()
  })

  it('returns the single row for a normal (today\'s) account', async () => {
    const db = supabaseStub([{ id: 'cfg-1', status: 'connected' }]) as never
    const row = await loadPrimaryWhatsAppConfigRow(db, 'acct-1')
    expect(row?.id).toBe('cfg-1')
  })

  it('with 2+ rows and none connected, picks the oldest (first in created_at order)', async () => {
    const db = supabaseStub([
      { id: 'cfg-old', status: 'disconnected' },
      { id: 'cfg-new', status: 'disconnected' },
    ]) as never
    const row = await loadPrimaryWhatsAppConfigRow(db, 'acct-1')
    expect(row?.id).toBe('cfg-old')
  })

  it('with 2+ rows, prefers the connected one even if it is not the oldest', async () => {
    const db = supabaseStub([
      { id: 'cfg-old', status: 'disconnected' },
      { id: 'cfg-new', status: 'connected' },
    ]) as never
    const row = await loadPrimaryWhatsAppConfigRow(db, 'acct-1')
    expect(row?.id).toBe('cfg-new')
  })

  it('never calls .single() or .maybeSingle() — only .select/.eq/.order', async () => {
    const rows = [{ id: 'cfg-1', status: 'connected' }] as Record<string, unknown>[]
    const selectBuilder: Record<string, unknown> = {}
    selectBuilder.eq = vi.fn(() => selectBuilder)
    selectBuilder.order = vi.fn(async () => ({ data: rows, error: null }))
    selectBuilder.single = vi.fn(() => {
      throw new Error('must not call .single()')
    })
    selectBuilder.maybeSingle = vi.fn(() => {
      throw new Error('must not call .maybeSingle()')
    })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => selectBuilder) })) } as never

    await expect(loadPrimaryWhatsAppConfigRow(db, 'acct-1')).resolves.toMatchObject({ id: 'cfg-1' })
  })
})

describe('loadActiveWhatsAppConfig', () => {
  it('returns null when there is no config row', async () => {
    const db = supabaseStub([]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toBeNull()
  })

  it('resolves a Meta row, decrypting access_token', async () => {
    const db = supabaseStub([
      { id: 'cfg-1', status: 'connected', provider: 'meta', phone_number_id: 'pn-1', access_token: 'enc-token' },
    ]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toEqual({
      provider: 'meta',
      phoneNumberId: 'pn-1',
      accessToken: 'decrypted:enc-token',
      configId: 'cfg-1',
    })
  })

  it('resolves a UAZAPI row, decrypting the instance token', async () => {
    const db = supabaseStub([
      {
        id: 'cfg-2',
        status: 'connected',
        provider: 'uazapi',
        uazapi_instance_id: 'inst-1',
        uazapi_instance_token: 'enc-instance-token',
      },
    ]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toEqual({
      provider: 'uazapi',
      instanceToken: 'decrypted:enc-instance-token',
      configId: 'cfg-2',
      uazapiInstanceId: 'inst-1',
    })
  })

  it('returns null for a Meta row missing access_token or phone_number_id', async () => {
    const db = supabaseStub([
      { id: 'cfg-1', status: 'connected', provider: 'meta', phone_number_id: null, access_token: 'enc-token' },
    ]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toBeNull()
  })

  it('returns null for a UAZAPI row with no instance token yet (mid-provisioning)', async () => {
    const db = supabaseStub([
      { id: 'cfg-2', status: 'disconnected', provider: 'uazapi', uazapi_instance_id: 'inst-1', uazapi_instance_token: null },
    ]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toBeNull()
  })

  it('throws on an unrecognized provider value', async () => {
    const db = supabaseStub([{ id: 'cfg-1', status: 'connected', provider: 'bogus' }]) as never
    await expect(loadActiveWhatsAppConfig(db, 'acct-1')).rejects.toThrow(/unrecognized provider/)
  })

  it('with 2+ rows, resolves the same connected row the deterministic rule picks', async () => {
    const db = supabaseStub([
      { id: 'cfg-old', status: 'disconnected', provider: 'meta', phone_number_id: 'pn-old', access_token: 'tok-old' },
      { id: 'cfg-new', status: 'connected', provider: 'uazapi', uazapi_instance_id: 'inst-new', uazapi_instance_token: 'tok-new' },
    ]) as never
    const config = await loadActiveWhatsAppConfig(db, 'acct-1')
    expect(config).toMatchObject({ provider: 'uazapi', configId: 'cfg-new' })
  })

  it('self-heals a legacy-format token by updating scoped to the row id, not account_id', async () => {
    mocks.isLegacyFormat.mockReturnValue(true)
    const updateSpy = vi.fn()
    const updateEqSpy = vi.fn()
    const db = supabaseStub(
      [{ id: 'cfg-1', status: 'connected', provider: 'meta', phone_number_id: 'pn-1', access_token: 'legacy-token' }],
      { updateSpy, updateEqSpy },
    ) as never

    await loadActiveWhatsAppConfig(db, 'acct-1')
    // fire-and-forget update — flush microtasks
    await new Promise((r) => setTimeout(r, 0))

    expect(updateSpy).toHaveBeenCalledWith({ access_token: 'encrypted:decrypted:legacy-token' })
    expect(updateEqSpy).toHaveBeenCalledWith('id', 'cfg-1')
  })
})
