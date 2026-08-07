// ============================================================
// Auth callback (PKCE code exchange). Reached today only from the
// password-recovery email link (see forgot-password's `redirectTo`),
// but written generically in case a future magic-link/OAuth flow
// wants to reuse it.
//
// Exchanges the one-time `code` for a session server-side — this
// writes the Supabase session cookies via the SSR client — then
// redirects to an allow-listed internal destination. Never forwards
// `code`, tokens, or Supabase's raw error message into the final URL
// or into logs.
// ============================================================

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { resolveSafeNextPath } from '@/lib/auth/safe-redirect'
import {
  RECOVERY_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_COOKIE_NAME,
  RECOVERY_COOKIE_PATH,
} from '@/lib/auth/recovery-cookie'

// Only the recovery destination is allow-listed today — extend this
// deliberately if another flow starts using this callback.
const ALLOWED_NEXT_PATHS = ['/reset-password'] as const

// Where a missing/invalid/expired code sends the visitor — the page
// that starts the flow, so they can just request a fresh link.
const ERROR_REDIRECT_PATH = '/forgot-password?error=invalid_link'
const DEFAULT_NEXT_PATH = '/login'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const safeNext = resolveSafeNextPath(
    url.searchParams.get('next'),
    ALLOWED_NEXT_PATHS,
    DEFAULT_NEXT_PATH,
  )

  if (!code) {
    return NextResponse.redirect(new URL(ERROR_REDIRECT_PATH, url.origin))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Nunca logar o código nem a mensagem crua do Supabase — pode
    // conter fragmentos sensíveis do fluxo de troca de token.
    console.error('[auth/callback] exchangeCodeForSession failed')
    return NextResponse.redirect(new URL(ERROR_REDIRECT_PATH, url.origin))
  }

  const response = NextResponse.redirect(new URL(safeNext, url.origin))

  // Only stamp the recovery marker when we're actually routing into
  // the recovery flow — a hypothetical future non-recovery use of
  // this callback (magic link, OAuth) has no reason to set it.
  if (safeNext === '/reset-password') {
    response.cookies.set(RECOVERY_COOKIE_NAME, '1', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: RECOVERY_COOKIE_PATH,
      maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
    })
  }

  return response
}
