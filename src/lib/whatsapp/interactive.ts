// ============================================================
// Interactive message payload — shared shape + validation.
//
// The persisted, round-trippable representation of a WhatsApp
// interactive message (reply buttons or a list). This is the single
// source of truth used by:
//   - the inbox composer + automation "send interactive" builders,
//   - the send-message core + automation engine (send + persist),
//   - the message bubble + preview (render),
//   - quick replies (store an interactive snippet).
//
// The field names (`id`/`title`/`description` on buttons/rows) match
// `meta-api.ts`'s `InteractiveButton` / `InteractiveListRow` /
// `InteractiveListSection` on purpose, so a payload maps straight onto
// the Meta send args with no translation.
//
// `validateInteractivePayload` mirrors the throws already inside the
// meta-api senders, but returns a result object so callers (API routes,
// activation checks) can surface a clean error to the user *before* the
// network call rather than turning a bad payload into a 400 from Meta
// mid-conversation.
// ============================================================

import { INTERACTIVE_LIMITS } from './meta-api'

export interface InteractiveButton {
  /** Stable id echoed back in the webhook when tapped. */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
}

export interface InteractiveButtonsPayload {
  kind: 'buttons'
  /** Body text shown above the buttons (≤ 1024 chars). */
  body: string
  /** Optional plain-text header (≤ 60 chars). */
  header?: string
  /** Optional grey footer line (≤ 60 chars). */
  footer?: string
  /** 1–3 buttons. */
  buttons: InteractiveButton[]
}

export interface InteractiveListRow {
  /** Stable id echoed back in the webhook when selected. */
  id: string
  /** Row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface InteractiveListPayload {
  kind: 'list'
  body: string
  header?: string
  footer?: string
  /** Label of the tap-to-expand button on the message bubble (≤ 20 chars). */
  button_label: string
  /** 1–10 rows TOTAL across all sections. */
  sections: InteractiveListSection[]
}

export type InteractiveMessagePayload =
  | InteractiveButtonsPayload
  | InteractiveListPayload

/**
 * Stable, English-independent identifier for each failure — added
 * alongside the existing `error` string (not replacing it) so a UI
 * layer with an i18n translator on hand (the automation builder, the
 * inbox composer) can render a localized message instead of the raw
 * English one, while `error` keeps working unchanged for any caller
 * that just logs it or shows it as-is (API responses, console).
 * `params` carries the dynamic bits (limits, offending ids/titles) for
 * ICU interpolation in the translated string.
 */
export type InteractiveValidationErrorCode =
  | 'payload_required'
  | 'body_required'
  | 'body_too_long'
  | 'header_too_long'
  | 'footer_too_long'
  | 'buttons_required'
  | 'too_many_buttons'
  | 'button_id_required'
  | 'duplicate_button_id'
  | 'button_label_required'
  | 'button_label_too_long'
  | 'list_button_label_required'
  | 'list_button_label_too_long'
  | 'sections_required'
  | 'too_many_sections'
  | 'section_rows_required'
  | 'row_id_required'
  | 'duplicate_row_id'
  | 'row_title_required'
  | 'row_title_too_long'
  | 'row_description_too_long'
  | 'rows_required'
  | 'too_many_rows'
  | 'invalid_kind'

export type InteractiveValidation =
  | { ok: true }
  | {
      ok: false
      error: string
      code: InteractiveValidationErrorCode
      params?: Record<string, string | number>
    }

function ok(): InteractiveValidation {
  return { ok: true }
}
function fail(
  code: InteractiveValidationErrorCode,
  error: string,
  params?: Record<string, string | number>,
): InteractiveValidation {
  return { ok: false, error, code, params }
}

function validateHeaderFooter(
  header: string | undefined,
  footer: string | undefined,
): InteractiveValidation {
  if (header && header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    return fail(
      'header_too_long',
      `Header exceeds the ${INTERACTIVE_LIMITS.headerTextMaxLength}-character limit.`,
      { limit: INTERACTIVE_LIMITS.headerTextMaxLength },
    )
  }
  if (footer && footer.length > INTERACTIVE_LIMITS.footerMaxLength) {
    return fail(
      'footer_too_long',
      `Footer exceeds the ${INTERACTIVE_LIMITS.footerMaxLength}-character limit.`,
      { limit: INTERACTIVE_LIMITS.footerMaxLength },
    )
  }
  return ok()
}

/**
 * Validate an interactive payload against Meta's hard limits + our
 * structural rules (non-empty ids/titles, unique ids). Returns a result
 * object rather than throwing so API routes can map it to a 400 with a
 * user-facing message.
 *
 * `unknown` in, narrowed here, so it's safe to call straight on a parsed
 * request body.
 */
export function validateInteractivePayload(
  payload: unknown,
): InteractiveValidation {
  if (!payload || typeof payload !== 'object') {
    return fail('payload_required', 'Interactive message payload is required.')
  }
  const p = payload as Partial<InteractiveMessagePayload>

  if (typeof p.body !== 'string' || p.body.trim() === '') {
    return fail('body_required', 'Interactive message body text is required.')
  }
  if (p.body.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    return fail(
      'body_too_long',
      `Body text exceeds the ${INTERACTIVE_LIMITS.bodyMaxLength}-character limit.`,
      { limit: INTERACTIVE_LIMITS.bodyMaxLength },
    )
  }
  const hf = validateHeaderFooter(p.header, p.footer)
  if (!hf.ok) return hf

  if (p.kind === 'buttons') {
    const buttons = (p as InteractiveButtonsPayload).buttons
    if (!Array.isArray(buttons) || buttons.length < 1) {
      return fail('buttons_required', 'Add at least one reply button.')
    }
    if (buttons.length > INTERACTIVE_LIMITS.maxButtons) {
      return fail(
        'too_many_buttons',
        `A reply-button message allows at most ${INTERACTIVE_LIMITS.maxButtons} buttons.`,
        { limit: INTERACTIVE_LIMITS.maxButtons },
      )
    }
    const seen = new Set<string>()
    for (const b of buttons) {
      if (!b || typeof b.id !== 'string' || b.id.trim() === '') {
        return fail('button_id_required', 'Every button needs an id.')
      }
      if (seen.has(b.id)) {
        return fail('duplicate_button_id', `Duplicate button id "${b.id}".`, { id: b.id })
      }
      seen.add(b.id)
      if (typeof b.title !== 'string' || b.title.trim() === '') {
        return fail('button_label_required', 'Every button needs a label.')
      }
      if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
        return fail(
          'button_label_too_long',
          `Button label "${b.title}" exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
          { title: b.title, limit: INTERACTIVE_LIMITS.buttonTitleMaxLength },
        )
      }
    }
    return ok()
  }

  if (p.kind === 'list') {
    const list = p as InteractiveListPayload
    if (
      typeof list.button_label !== 'string' ||
      list.button_label.trim() === ''
    ) {
      return fail('list_button_label_required', 'The list needs a button label.')
    }
    if (list.button_label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      return fail(
        'list_button_label_too_long',
        `List button label exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
        { limit: INTERACTIVE_LIMITS.buttonTitleMaxLength },
      )
    }
    if (!Array.isArray(list.sections) || list.sections.length < 1) {
      return fail('sections_required', 'Add at least one list section.')
    }
    if (list.sections.length > INTERACTIVE_LIMITS.maxListSections) {
      return fail(
        'too_many_sections',
        `A list allows at most ${INTERACTIVE_LIMITS.maxListSections} sections.`,
        { limit: INTERACTIVE_LIMITS.maxListSections },
      )
    }
    const seen = new Set<string>()
    let total = 0
    for (const section of list.sections) {
      if (!section || !Array.isArray(section.rows)) {
        return fail('section_rows_required', 'Every list section needs rows.')
      }
      for (const row of section.rows) {
        total++
        if (!row || typeof row.id !== 'string' || row.id.trim() === '') {
          return fail('row_id_required', 'Every list row needs an id.')
        }
        if (seen.has(row.id)) {
          return fail('duplicate_row_id', `Duplicate list row id "${row.id}".`, { id: row.id })
        }
        seen.add(row.id)
        if (typeof row.title !== 'string' || row.title.trim() === '') {
          return fail('row_title_required', 'Every list row needs a title.')
        }
        if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
          return fail(
            'row_title_too_long',
            `List row title "${row.title}" exceeds the ${INTERACTIVE_LIMITS.listRowTitleMaxLength}-character limit.`,
            { title: row.title, limit: INTERACTIVE_LIMITS.listRowTitleMaxLength },
          )
        }
        if (
          row.description &&
          row.description.length >
            INTERACTIVE_LIMITS.listRowDescriptionMaxLength
        ) {
          return fail(
            'row_description_too_long',
            `List row description exceeds the ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength}-character limit.`,
            { limit: INTERACTIVE_LIMITS.listRowDescriptionMaxLength },
          )
        }
      }
    }
    if (total < 1) return fail('rows_required', 'Add at least one list row.')
    if (total > INTERACTIVE_LIMITS.maxListRowsTotal) {
      return fail(
        'too_many_rows',
        `A list allows at most ${INTERACTIVE_LIMITS.maxListRowsTotal} rows in total.`,
        { limit: INTERACTIVE_LIMITS.maxListRowsTotal },
      )
    }
    return ok()
  }

  return fail('invalid_kind', 'Interactive message must be reply buttons or a list.')
}

/**
 * Short single-line summary used for `conversations.last_message_text`
 * and quick-reply list rows — the body, trimmed, or a sensible fallback.
 */
export function interactivePayloadPreviewText(
  payload: InteractiveMessagePayload,
): string {
  const body = payload.body?.trim()
  if (body) return body
  return payload.kind === 'buttons' ? '[buttons]' : '[list]'
}
