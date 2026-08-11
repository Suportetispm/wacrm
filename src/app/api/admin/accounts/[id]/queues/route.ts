// ============================================================
// /api/admin/accounts/[id]/queues
//
//   GET — lists the non-archived queues belonging to one company.
//         Platform admin.
//
// Why this exists: the tenant-scoped `GET /api/queues` (see
// src/app/api/queues/route.ts) is RLS-scoped to the CALLER's own
// account via getCurrentAccount()/requireRole() — a platform admin
// has no tenant membership by design (requirePlatformAdmin() never
// touches profiles/accounts, see src/lib/auth/platform-admin.ts), so
// that route cannot serve "list queues for an arbitrary company the
// admin picked in a dropdown". This is a thin, read-only,
// cross-tenant equivalent for that one need — it does not duplicate
// or replace anything in src/app/api/queues/**, and does not touch
// the `queues` table's schema or RLS policies.
//
// Consumed by the create/edit-user UI (/admin/users) to populate the
// "queues" picker for the currently selected company.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, toPlatformErrorResponse } from '@/lib/auth/platform-admin'
import { supabaseAdmin } from '@/lib/platform/admin-client'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    return toPlatformErrorResponse(err)
  }

  const { id } = await params

  // service_role: a platform admin is not a member of this account,
  // so the RLS-scoped client would see zero rows — legitimate here
  // only because requirePlatformAdmin() already authorized the caller.
  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('queues')
    .select('id, name, color, is_active')
    .eq('account_id', id)
    .is('archived_at', null)
    .order('name', { ascending: true })

  if (error) {
    console.error('[GET /api/admin/accounts/[id]/queues] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load queues' }, { status: 500 })
  }

  return NextResponse.json({ queues: data ?? [] })
}
