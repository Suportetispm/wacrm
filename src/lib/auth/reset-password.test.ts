import { describe, expect, it, vi } from 'vitest'

import { MIN_PASSWORD, submitNewPassword, validateNewPassword } from './reset-password'

describe('validateNewPassword', () => {
  it('rejects a password shorter than the minimum', () => {
    expect(validateNewPassword('short', 'short', 8)).toBe('too_short')
  })

  it('rejects mismatched passwords', () => {
    expect(validateNewPassword('longenough1', 'longenough2', 8)).toBe('mismatch')
  })

  it('accepts a valid, matching pair', () => {
    expect(validateNewPassword('longenough1', 'longenough1', 8)).toBeNull()
  })
})

describe('submitNewPassword', () => {
  it('J: calls updateUser with the new password when validation passes', async () => {
    const updateUser = vi.fn(async () => ({ error: null }))
    const result = await submitNewPassword({ updateUser }, 'longenough1', 'longenough1', 8)
    expect(result).toEqual({ ok: true })
    expect(updateUser).toHaveBeenCalledWith({ password: 'longenough1' })
  })

  it('rejects mismatched passwords without ever calling updateUser', async () => {
    const updateUser = vi.fn(async () => ({ error: null }))
    const result = await submitNewPassword({ updateUser }, 'longenough1', 'different1', 8)
    expect(result).toEqual({ ok: false, error: 'mismatch' })
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('surfaces a Supabase update error without leaking its message', async () => {
    const updateUser = vi.fn(async () => ({ error: { message: 'some internal detail' } }))
    const result = await submitNewPassword({ updateUser }, 'longenough1', 'longenough1', 8)
    expect(result).toEqual({ ok: false, error: 'update_failed' })
  })

  it('uses the exported MIN_PASSWORD as the default minimum', async () => {
    const updateUser = vi.fn(async () => ({ error: null }))
    const shortPassword = 'a'.repeat(MIN_PASSWORD - 1)
    const result = await submitNewPassword({ updateUser }, shortPassword, shortPassword)
    expect(result).toEqual({ ok: false, error: 'too_short' })
    expect(updateUser).not.toHaveBeenCalled()
  })
})
