// ============================================================
// Pure, framework-free helpers for the /admin/users UI
// (src/components/admin/users-panel.tsx).
//
// Extracted from the component so this logic can be unit-tested —
// this repo has no React component-testing setup (no
// @testing-library/react, vitest runs with `environment: "node"`),
// so anything that needs `render()` can't be covered directly.
// Keeping the actual decision logic here, imported by the component
// rather than re-implemented in the tests, means the tests exercise
// the real code path.
// ============================================================

import type { ManagedAccountRole } from './users'

export type UsersStatusFilter = 'all' | 'true' | 'false'
export type UsersRoleFilter = 'all' | ManagedAccountRole

export interface UsersListFilters {
  q: string
  accountId: string
  role: UsersRoleFilter
  isActive: UsersStatusFilter
}

/** i18n key under `Admin.users` for each managed role's display label. */
export const ROLE_LABEL_KEYS: Record<ManagedAccountRole, 'roleAdmin' | 'roleAgent'> = {
  admin: 'roleAdmin',
  agent: 'roleAgent',
}

/**
 * Builds the query string for `GET /api/admin/users` from the panel's
 * filter state. Empty/`'all'` values are omitted entirely rather than
 * sent as empty params, matching what the route expects (see
 * src/app/api/admin/users/route.ts).
 */
export function buildUsersQueryParams(filters: UsersListFilters): URLSearchParams {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q) params.set('q', q)
  if (filters.accountId) params.set('account_id', filters.accountId)
  if (filters.role !== 'all') params.set('role', filters.role)
  if (filters.isActive !== 'all') params.set('is_active', filters.isActive)
  return params
}

export interface UserApiErrorInfo {
  /**
   * i18n key (under `Admin.users`) for a distinct, translated,
   * friendly message. `null` means: show `detail` instead (already a
   * safe, hand-authored string from the API layer — see
   * src/app/api/admin/users/**'s route tests, which pin that these
   * never leak ids/passwords/internals).
   */
  translatedKey: 'errorEmailExists' | 'errorForbidden' | 'errorGeneric' | null
  detail: string | null
}

/**
 * Classifies a failed create/update response into what to show the
 * operator. Mirrors the status codes the API layer actually returns
 * (see PARTE 9 of the 6C.3C brief): 409 email conflict gets its own
 * translated message (friendlier than the raw English server text);
 * 400s show the server's own message as-is, since every 400 the API
 * returns is already a curated, safe string (never SQL/stack/ids —
 * pinned by the route tests), matching this codebase's existing
 * convention (see src/components/settings/invite-member-dialog.tsx);
 * 403/anything else collapses to a generic translated message —
 * never the raw body for those, since a 500 body is not guaranteed
 * to be safe to show.
 */
export function classifyUserApiError(
  status: number,
  body: { error?: unknown } | null,
): UserApiErrorInfo {
  const serverMessage = typeof body?.error === 'string' ? body.error : null

  if (status === 409) return { translatedKey: 'errorEmailExists', detail: null }
  if (status === 400) return { translatedKey: null, detail: serverMessage }
  if (status === 403) return { translatedKey: 'errorForbidden', detail: null }
  return { translatedKey: 'errorGeneric', detail: null }
}

/** Mirrors the server-side minimum in src/app/api/admin/users/route.ts
 *  — kept in sync manually (no shared constant module between the two
 *  layers today); a mismatch only ever makes the client check
 *  stricter or looser than the server, never a security issue since
 *  the server re-validates independently either way. */
export const MIN_PASSWORD_LENGTH = 8

export interface UserFormState {
  fullName: string
  email: string
  password: string
  accountId: string
  role: ManagedAccountRole
  queueIds: string[]
  isActive: boolean
}

/** Pristine create-form state. Notably `password: ''` — reused both to
 *  open a fresh dialog and to reset after a successful create, so the
 *  password never lingers in state once it's done its one job. */
export function emptyUserFormState(): UserFormState {
  return {
    fullName: '',
    email: '',
    password: '',
    accountId: '',
    role: 'agent',
    queueIds: [],
    isActive: true,
  }
}

/**
 * Selected queue ids after the "Company" field changes. Filas
 * pertencem a UMA empresa — a seleção anterior nunca é válida para a
 * empresa nova, então ela é sempre descartada quando accountId muda,
 * e preservada quando não muda (e.g. re-render por outro campo).
 */
export function queueSelectionOnAccountChange(
  previousAccountId: string,
  nextAccountId: string,
  currentQueueIds: string[],
): string[] {
  return previousAccountId === nextAccountId ? currentQueueIds : []
}

/** POST /api/admin/users body from the create-dialog form state. */
export function buildCreateUserPayload(form: UserFormState) {
  return {
    full_name: form.fullName.trim(),
    email: form.email.trim(),
    password: form.password,
    account_id: form.accountId,
    account_role: form.role,
    queue_ids: form.queueIds,
  }
}

/** PATCH /api/admin/users/[id] body from the edit-dialog form state.
 *  Never includes email/account_id/password — those fields aren't
 *  editable in this version (see src/app/api/admin/users/[id]/route.ts,
 *  which rejects them outright if present). */
export function buildUpdateUserPayload(form: UserFormState) {
  return {
    full_name: form.fullName.trim(),
    account_role: form.role,
    is_active: form.isActive,
    queue_ids: form.queueIds,
  }
}

/** Client-side pre-check mirroring the server's own validation (see
 *  src/app/api/admin/users/route.ts / [id]/route.ts) — purely a UX
 *  nicety to disable the submit button; the server re-validates
 *  everything regardless and is the real authority. */
export function isUserFormValid(mode: 'create' | 'edit', form: UserFormState): boolean {
  if (!form.fullName.trim()) return false
  if (mode === 'create') {
    if (!form.email.trim()) return false
    if (form.password.length < MIN_PASSWORD_LENGTH) return false
    if (!form.accountId) return false
  }
  return true
}
