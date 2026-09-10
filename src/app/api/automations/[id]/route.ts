import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permission-guard'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

const GENERIC_ERROR = 'Failed to process the request'

function sqlCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return 'unknown_error'
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Reading still needs the caller's own account_id resolved server-side —
  // the service-role client below bypasses RLS's account_id scoping, so
  // it must be re-applied explicitly here (never trust a client-supplied
  // account_id, and never authorize by user_id alone across accounts).
  let ctx
  try {
    ctx = await requirePermission('automations.view')
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
    .maybeSingle()

  if (error) {
    console.error('[automations/[id]] GET failed:', sqlCode(error))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let steps
  try {
    steps = await loadStepsTree(id)
  } catch (err) {
    console.error('[automations/[id]] GET steps load failed:', err)
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce both the role and the account scope
  // here (never trust a client-supplied account_id).
  let ctx
  try {
    ctx = await requirePermission('automations.manage')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const admin = supabaseAdmin()

  // Ownership + tenant check before we touch anything. Load the fields we
  // need to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, user_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!existing || existing.user_id !== ctx.userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    let mergedSteps
    try {
      mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)
    } catch (err) {
      console.error('[automations/[id]] PATCH steps load failed:', err)
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (updErr) {
      console.error('[automations/[id]] PATCH update failed:', sqlCode(updErr))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
    }
  }

  if (Array.isArray(body.steps)) {
    // replaceSteps() already logs the underlying sqlCode server-side and
    // returns a generic, client-safe message on failure.
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Deleting an automation is a write — enforce `agent` plus the account
  // scope (the service-role client below bypasses the agent-gated
  // automations_delete RLS, so both checks must happen here).
  let ctx
  try {
    ctx = await requirePermission('automations.manage')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
  if (error) {
    console.error('[automations/[id]] DELETE failed:', sqlCode(error))
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
