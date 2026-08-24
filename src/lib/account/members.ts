import type { AccountMember } from '@/types';

/**
 * Fetch the current account's members from the API (which applies the
 * email-visibility rules — agents/viewers don't see emails). Best-effort:
 * returns `[]` on any error or on an older deployment without the
 * endpoint, so callers can fall back to a queue-only / raw-id picker.
 *
 * Client-side only (uses `fetch` against the relative API route).
 */
export async function fetchAccountMembers(): Promise<AccountMember[]> {
  try {
    const res = await fetch('/api/account/members', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { members?: AccountMember[] };
    return json.members ?? [];
  } catch {
    return [];
  }
}

/** The subset of member fields every label/select-item helper below
 *  actually needs. Deliberately looser than `AccountMember` itself
 *  (`full_name`/`email` allowed null) — some call sites (e.g.
 *  queue-members-dialog.tsx, team-members-dialog.tsx) declare their
 *  own locally-scoped, slightly looser member shape rather than
 *  importing the shared type, and both should satisfy this. */
interface MemberLike {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

/** Display label for a member: full name → email → raw id. */
export function memberLabel(m: MemberLike): string {
  return m.full_name || m.email || m.user_id;
}

/**
 * `{value, label}` pairs for a member-picker Select's `items` prop —
 * `value` stays the member's `user_id` (UUID), `label` is
 * `memberLabel(m)`. base-ui's closed-trigger `<Select.Value>` only
 * resolves its displayed label from `Select.Root`'s `items` (never
 * from the rendered `<SelectItem>` children — see
 * node_modules/@base-ui/react/internals/resolveValueLabel.js), so
 * without this a picked member renders as a raw UUID once selected.
 * Used by queue-members-dialog.tsx and
 * settings/internal-tickets/team-members-dialog.tsx, which both
 * already build their candidate list with the same
 * `full_name || email || raw id` fallback this mirrors.
 */
export function buildMemberSelectItems(
  members: MemberLike[],
): { value: string; label: string }[] {
  return members.map((m) => ({ value: m.user_id, label: memberLabel(m) }));
}

/**
 * `{value, label}` pairs for the account-role Select's `items` prop —
 * admin/agent/viewer, in the order every current caller already
 * lists them. Same "items required for the closed trigger" reasoning
 * as buildMemberSelectItems above. `tRoles` is whatever
 * `useTranslations('Settings.roles')` the caller already has — the
 * label text itself is untouched, this only wires the existing
 * translation into `items`.
 */
export function buildAccountRoleSelectItems(
  tRoles: (key: 'admin' | 'agent' | 'viewer') => string,
): { value: string; label: string }[] {
  return [
    { value: 'admin', label: tRoles('admin') },
    { value: 'agent', label: tRoles('agent') },
    { value: 'viewer', label: tRoles('viewer') },
  ];
}
