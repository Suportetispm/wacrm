import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { platformRpcErrorToResponse } from './rpc-errors'

describe('platformRpcErrorToResponse', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('42501 -> 403, message passed through, and logged for diagnosis', async () => {
    const res = platformRpcErrorToResponse(
      { code: '42501', message: 'Forbidden' } as never,
      'Failed to update user',
    )
    const json = await res.json()
    expect(res.status).toBe(403)
    expect(json.error).toBe('Forbidden')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('22023 -> 400, message passed through, and logged for diagnosis', async () => {
    const res = platformRpcErrorToResponse(
      { code: '22023', message: 'User is not managed by the platform user management operation' } as never,
      'Failed to update user',
    )
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe('User is not managed by the platform user management operation')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('23505 -> 409, message passed through, and logged for diagnosis', async () => {
    const res = platformRpcErrorToResponse(
      { code: '23505', message: 'Already exists' } as never,
      'Failed to update user',
    )
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toBe('Already exists')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('an unrecognized code -> 500 with the generic fallback (never the raw RPC message), still logged with its code for diagnosis', async () => {
    const res = platformRpcErrorToResponse(
      { code: '58P01', message: 'could not access file "some/internal/path"' } as never,
      'Failed to update user',
    )
    const json = await res.json()
    expect(res.status).toBe(500)
    expect(json.error).toBe('Failed to update user')
    expect(JSON.stringify(json)).not.toContain('some/internal/path')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('never logs the raw error object itself, only code/message (no hint/detail/query leakage)', async () => {
    const err = {
      code: '22023',
      message: 'safe message',
      details: 'internal detail that must never be logged as-is via the raw object',
      hint: 'internal hint',
    }
    platformRpcErrorToResponse(err as never, 'fallback')
    for (const call of errorSpy.mock.calls) {
      expect(call).not.toContain(err)
    }
  })
})
