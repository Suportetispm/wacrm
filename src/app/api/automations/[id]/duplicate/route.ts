import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permission-guard'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const GENERIC_ERROR = 'Failed to process the request'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Duplicating creates a new automation row — a write. Enforce `agent`
  // plus the account scope (the service-role client below bypasses the
  // agent-gated automations_insert RLS, so both checks must happen here).
  let ctx
  try {
    ctx = await requirePermission('automations.manage')
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  // The source automation must belong to the caller's own account — never
  // trust that a valid id implies the caller is allowed to read/clone it.
  const { data: original, error: origErr } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
    .maybeSingle()
  if (origErr) {
    console.error('[automations/[id]/duplicate] source lookup failed:', sqlCode(origErr))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: copy, error: copyErr } = await admin
    .from('automations')
    .insert({
      // Always the caller's own current account — deliberately NOT
      // original.account_id (even though it's already been verified to
      // equal ctx.accountId above), so a clone can never land outside the
      // account that owns this request.
      account_id: ctx.accountId,
      user_id: ctx.userId,
      name: `${original.name} (Copy)`,
      description: original.description,
      trigger_type: original.trigger_type,
      trigger_config: original.trigger_config,
      is_active: false,
    })
    .select()
    .single()
  if (copyErr || !copy) {
    console.error('[automations/[id]/duplicate] copy insert failed:', sqlCode(copyErr))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }

  const { data: steps } = await admin
    .from('automation_steps')
    .select('id, parent_step_id, branch, step_type, step_config, position')
    .eq('automation_id', id)
    .order('position', { ascending: true })

  if (steps && steps.length > 0) {
    // Re-map parent_step_id: build old→new id map first so the second
    // pass inserts rows with correct parent references.
    const idMap = new Map<string, string>()
    const uid = () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    for (const row of steps) idMap.set(row.id as string, uid())

    const rows = steps.map((row) => ({
      id: idMap.get(row.id as string)!,
      automation_id: copy.id,
      parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
      branch: row.branch,
      step_type: row.step_type,
      step_config: row.step_config,
      position: row.position,
    }))
    const { error: insErr } = await admin.from('automation_steps').insert(rows)
    if (insErr) {
      console.error('[automations/[id]/duplicate] steps insert failed:', sqlCode(insErr))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
  }

  return NextResponse.json({ automation: copy }, { status: 201 })
}
