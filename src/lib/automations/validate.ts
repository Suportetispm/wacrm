import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
//
// This module runs on the server (called from the API routes) and has
// no i18n of its own — `message` stays plain English, for logs/API
// consumers that just want a string. `code` (+ `params` for dynamic
// bits like a step number) is the stable, English-independent part;
// the client (automation-builder.tsx, which already has a translator
// in scope) maps `code` to a localized message instead of showing
// `message` or `path` to the end user.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. Technical — never shown to the end user, only logged. */
  path: string
  /** Plain-English fallback/log message. Never shown directly in the UI. */
  message: string
  /** Stable, English-independent identifier the UI translates. */
  code: string
  /** Interpolation params for the translated message (e.g. step number). */
  params?: Record<string, string | number>
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
      code: 'no_steps',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    // 1-indexed, human-facing step number — `path` stays technical
    // (logged, never shown), `step` is what the translated message
    // interpolates ("Step {step}: ...").
    validateOne(s, path, i + 1, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, stepNumber: number, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: 'message text is required',
          code: 'text_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({
          path: `${path}.interactive`,
          message: result.error,
          code: `interactive_${result.code}`,
          params: { ...result.params, step: stepNumber },
        })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({
          path: `${path}.template_name`,
          message: 'template name is required',
          code: 'template_name_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({
          path: `${path}.tag_id`,
          message: 'tag is required',
          code: 'tag_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
          code: 'agent_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({
          path: `${path}.field`,
          message: 'field name is required',
          code: 'field_name_required',
          params: { step: stepNumber },
        })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: 'field value is required',
          code: 'field_value_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
          code: 'pipeline_required',
          params: { step: stepNumber },
        })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({
          path: `${path}.stage_id`,
          message: 'stage is required',
          code: 'stage_required',
          params: { step: stepNumber },
        })
      }
      if (!nonEmpty(c.title)) {
        issues.push({
          path: `${path}.title`,
          message: 'title is required',
          code: 'deal_title_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({
          path: `${path}.amount`,
          message: 'wait amount must be greater than 0',
          code: 'wait_amount_invalid',
          params: { step: stepNumber },
        })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
          code: 'wait_unit_invalid',
          params: { step: stepNumber },
        })
      }
      break
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: 'condition subject is required',
          code: 'condition_subject_required',
          params: { step: stepNumber },
        })
      }
      if (!nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: 'condition operand is required',
          code: 'condition_operand_required',
          params: { step: stepNumber },
        })
      }
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is required',
          code: 'webhook_url_required',
          params: { step: stepNumber },
        })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
            code: 'webhook_url_scheme_invalid',
            params: { step: stepNumber },
          })
        }
      } catch {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is not a valid URL',
          code: 'webhook_url_malformed',
          params: { step: stepNumber },
        })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({
        path,
        message: `unknown step type: ${step.step_type}`,
        code: 'unknown_step_type',
        params: { step: stepNumber },
      })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'at least one keyword is required',
        code: 'trigger_keywords_required',
      })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.keywords',
        message: 'keywords cannot be empty strings',
        code: 'trigger_keywords_empty',
      })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (cfg.match_type != null && cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
        code: 'trigger_match_type_invalid',
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message: 'schedule is required',
        code: 'trigger_schedule_required',
      })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({
        path: 'trigger.tag_id',
        message: 'tag is required',
        code: 'trigger_tag_required',
      })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
        code: 'trigger_reply_ids_required',
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
        code: 'trigger_reply_ids_empty',
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
