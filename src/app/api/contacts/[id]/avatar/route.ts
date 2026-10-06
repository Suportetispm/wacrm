import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// GET /api/contacts/[id]/avatar — serves a contact's synced WhatsApp
// profile picture (migration 085: contacts.whatsapp_avatar_path in the
// private `whatsapp-attachments` bucket) by redirecting to a short-lived
// signed URL. Same model as GET /api/messages/[messageId]/attachment:
// the bucket has no RLS read policy, so only the service-role client can
// sign, and this route is the only way a browser ever reaches the file.
//
// Unlike the attachment route, "doesn't exist", "belongs to another
// account" and "has no photo" all answer the SAME 404 — an avatar URL
// is rendered for every contact in the Inbox, so this must not become a
// way to probe which contact ids exist in other accounts.
//
// No route-specific Cache-Control: the project-wide /api/* policy
// (next.config.ts) applies. The UI adds a `?v=` with the content hash,
// so a changed photo is always a new URL.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BUCKET = 'whatsapp-attachments'
const SIGNED_URL_TTL_SECONDS = 300

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!UUID_RE.test(id)) return notFound()

  const admin = supabaseAdmin()
  const { data: contact, error } = await admin
    .from('contacts')
    .select('id, account_id, whatsapp_avatar_path')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) {
    console.error('[contacts/avatar] contact lookup failed')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!contact || contact.account_id !== ctx.accountId) return notFound()

  const path = contact.whatsapp_avatar_path
  // Defense in depth: only ever sign this contact's own avatar prefix.
  if (typeof path !== 'string' || !path.startsWith(`${ctx.accountId}/contacts/${id}/`)) {
    return notFound()
  }

  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed?.signedUrl) {
    console.error('[contacts/avatar] signing failed')
    return NextResponse.json({ error: 'Avatar temporarily unavailable' }, { status: 503 })
  }

  return NextResponse.redirect(signed.signedUrl, 302)
}
