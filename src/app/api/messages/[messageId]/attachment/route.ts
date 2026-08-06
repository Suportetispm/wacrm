import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// GET /api/messages/[messageId]/attachment — resolves an inbound PDF or
// image (migration 042/043: media_storage_path in the private
// `whatsapp-attachments` bucket) into a short-lived signed URL. The
// bucket has no RLS policy at all — only the service-role client
// (`supabaseAdmin()`) can read it, so this route is the sole sanctioned
// path for a browser to ever reach a stored attachment.
//
// The message/conversation lookup below deliberately also uses the
// admin client rather than the caller's RLS-scoped session client: RLS
// on `messages` filters out rows from other accounts entirely, which
// would collapse "message doesn't exist" (404) and "message belongs to
// another account" (403) into the same response. Doing the lookup with
// the admin client and comparing account_id explicitly lets us return
// the correct status for each case. Two separate point lookups (by
// message id, then by conversation id) rather than an embedded FK
// join, per the same PostgREST schema-cache staleness reasoning
// documented in `getCurrentAccount()`.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SIGNED_URL_TTL_SECONDS = 60
const BUCKET = 'whatsapp-attachments'

// content_type -> allowed media_mime_type values. Mirrors the two
// inbound webhook paths that ever populate media_storage_path
// (uazapi-webhook-document-persist.ts, uazapi-webhook-image-persist.ts)
// and the bucket's own allowed_mime_types (migration 043).
const ALLOWED_MIME_TYPES_BY_CONTENT_TYPE: Record<string, readonly string[]> = {
  document: ['application/pdf'],
  image: ['image/jpeg', 'image/png', 'image/webp'],
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { messageId } = await params
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'Invalid message id.' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  const { data: message, error: messageErr } = await admin
    .from('messages')
    .select(
      'id, conversation_id, content_type, media_storage_path, media_file_name, media_mime_type, media_file_size',
    )
    .eq('id', messageId)
    .maybeSingle()

  if (messageErr) {
    console.error('[messages/attachment] message lookup failed')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }

  const { data: conversation, error: conversationErr } = await admin
    .from('conversations')
    .select('account_id')
    .eq('id', message.conversation_id)
    .maybeSingle()

  if (conversationErr) {
    console.error('[messages/attachment] conversation lookup failed')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!conversation || conversation.account_id !== ctx.accountId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const allowedMimeTypes = ALLOWED_MIME_TYPES_BY_CONTENT_TYPE[message.content_type]
  if (!allowedMimeTypes || !message.media_mime_type || !allowedMimeTypes.includes(message.media_mime_type)) {
    return NextResponse.json({ error: 'Unsupported attachment type' }, { status: 415 })
  }

  if (!message.media_storage_path) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
  }

  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(message.media_storage_path, SIGNED_URL_TTL_SECONDS)

  if (signErr || !signed?.signedUrl) {
    console.error('[messages/attachment] signing failed')
    return NextResponse.json({ error: 'Attachment temporarily unavailable' }, { status: 503 })
  }

  return NextResponse.json({
    url: signed.signedUrl,
    fileName: message.media_file_name,
    mimeType: message.media_mime_type,
    fileSize: message.media_file_size,
  })
}
