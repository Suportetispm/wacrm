import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ACCOUNT_FEATURE_KEYS } from "@/lib/accounts/feature-flags";

/**
 * Migration 083 — Inbox visibility mode is decided per account:
 *   `inbox_account_wide` = true  → account-wide (rule of 082)
 *   flag absent / false          → segmented by Setor (rule of 059/076)
 *
 * There is no Postgres in the unit-test environment, so, like
 * ./account-wide-visibility.test.ts, the RLS is checked from the
 * migration text. Beyond structural assertions, the USING / WITH CHECK
 * clauses of the EFFECTIVE policies are parsed into a boolean formula
 * and evaluated against an in-memory model of is_account_member(),
 * is_account_feature_enabled() and queue_members — so every scenario
 * below exercises the AND/OR structure that is actually in the SQL.
 * The proof against a real database (impersonated JWTs) lives in
 * supabase/validation/083_inbox_visibility_mode_by_account_check.sql.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const MIGRATION_083 = "083_inbox_visibility_mode_by_account.sql";
const MIGRATION_071 = "071_account_feature_flags.sql";

const ARACAGI = "3b1cc850-7de0-48df-ba1b-d6334b000c3b";
const COHAMA = "33e1388c-fb0a-457f-ba8e-c01d236897c5";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function readMigration(file: string): string {
  return normalize(stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8")));
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Index just past the `)` that closes the paren opened right before `start`. */
function closingParen(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    if (depth === 0) return i + 1;
  }
  throw new Error("unbalanced parentheses");
}

function clause(body: string, keyword: "using" | "with check"): string | null {
  const match = new RegExp(`\\b${keyword.replace(" ", "\\s+")}\\s*\\(`, "i").exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  return normalize(body.slice(start, closingParen(body, start) - 1));
}

interface PolicyDef {
  file: string;
  body: string;
}

/** Effective policy per `${table}.${policy}` after replaying every migration in order. */
function effectivePolicies(): Map<string, PolicyDef> {
  const policies = new Map<string, PolicyDef>();
  const stmtRe =
    /(create|drop)\s+policy\s+(?:if\s+exists\s+)?(?:"([^"]+)"|(\w+))\s+on\s+(?:public\.)?(\w+)([\s\S]*?);/gi;
  for (const file of migrationFiles()) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const m of sql.matchAll(stmtRe)) {
      const key = `${m[4].toLowerCase()}.${(m[2] ?? m[3]).toLowerCase()}`;
      if (m[1].toLowerCase() === "drop") policies.delete(key);
      else policies.set(key, { file, body: m[5] });
    }
  }
  return policies;
}

/** `create or replace function public.<name>( … $$;` from a normalized migration. */
function functionDef(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3);
}

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const sql083 = readMigration(MIGRATION_083);
const policies = effectivePolicies();

function policy(key: string): PolicyDef {
  const def = policies.get(key);
  if (!def) throw new Error(`policy ${key} not found in migrations`);
  return def;
}

// ------------------------------------------------------------
// SQL clause → boolean formula → evaluation against a model
// ------------------------------------------------------------

const QUEUE_MEMBER_EXISTS =
  "select 1 from public.queue_members qm where qm.queue_id = conversations.queue_id and qm.user_id = auth.uid() and qm.account_id = conversations.account_id and qm.is_active";
const ASSIGNEE_PROFILE_EXISTS =
  "select 1 from public.profiles p where p.user_id = conversations.assigned_agent_id and p.account_id = conversations.account_id";

// Longest first — the bare is_account_member(account_id) is a prefix of nothing
// here, but keep role-qualified forms ahead of it for clarity.
const ATOMS: [string, string][] = [
  ["public.is_account_feature_enabled(account_id, 'inbox_account_wide')", "ACCOUNT_WIDE"],
  ["public.is_account_member(account_id, 'admin')", "ADMIN"],
  ["public.is_account_member(account_id, 'agent')", "AGENT"],
  ["public.is_account_member(account_id)", "MEMBER"],
  ["assigned_agent_id = auth.uid()", "ASSIGNED_TO_ME"],
  ["assigned_agent_id is null", "UNASSIGNED"],
];

function toFormula(clauseSql: string): string {
  let out = "";
  let rest = clauseSql;
  for (;;) {
    const at = rest.indexOf("exists (");
    if (at < 0) break;
    const innerStart = at + "exists (".length;
    const end = closingParen(rest, innerStart);
    const inner = rest.slice(innerStart, end - 1).trim();
    let atom: string;
    if (inner === QUEUE_MEMBER_EXISTS) atom = "QUEUE_MEMBER";
    else if (inner === ASSIGNEE_PROFILE_EXISTS) atom = "ASSIGNEE_IN_ACCOUNT";
    else throw new Error(`unexpected EXISTS subquery in policy: ${inner}`);
    out += rest.slice(0, at) + atom;
    rest = rest.slice(end);
  }
  out += rest;
  for (const [sql, atom] of ATOMS) out = out.split(sql).join(atom);
  return out;
}

/** AND binds tighter than OR, exactly like SQL. Any unrecognised token throws. */
function evaluate(formula: string, atoms: Record<string, boolean>): boolean {
  const tokens = formula.match(/\(|\)|[A-Z_]+|[^\s()]+/g) ?? [];
  let pos = 0;
  const primary = (): boolean => {
    const token = tokens[pos++];
    if (token === "(") {
      const value = or();
      if (tokens[pos++] !== ")") throw new Error("expected )");
      return value;
    }
    if (token === undefined || !(token in atoms)) {
      throw new Error(`unmodelled SQL in policy: ${token}`);
    }
    return atoms[token];
  };
  const and = (): boolean => {
    let value = primary();
    while (tokens[pos] === "and") {
      pos++;
      const right = primary();
      value = value && right;
    }
    return value;
  };
  function or(): boolean {
    let value = and();
    while (tokens[pos] === "or") {
      pos++;
      const right = and();
      value = value || right;
    }
    return value;
  }
  const result = or();
  if (pos !== tokens.length) throw new Error(`trailing SQL in policy: ${tokens[pos]}`);
  return result;
}

type Role = "owner" | "admin" | "agent" | "viewer";
const RANK: Record<Role, number> = { owner: 4, admin: 3, agent: 2, viewer: 1 };

interface User {
  id: string;
  accountId: string;
  role: Role;
  isActive?: boolean;
}

interface Conv {
  accountId: string;
  queueId: string | null;
  assignee: string | null;
}

interface QueueMember {
  accountId: string;
  queueId: string;
  userId: string;
  isActive: boolean;
}

interface World {
  /** account_feature_flags rows for `inbox_account_wide`; absent key = no row. */
  flags: Record<string, boolean>;
  users: User[];
  queueMembers: QueueMember[];
}

function atomsFor(world: World, user: User, conv: Conv): Record<string, boolean> {
  // is_account_member (048): same account + active profile (+ active account).
  const member = (min: Role) =>
    user.accountId === conv.accountId && user.isActive !== false && RANK[user.role] >= RANK[min];
  return {
    MEMBER: member("viewer"),
    AGENT: member("agent"),
    ADMIN: member("admin"),
    // is_account_feature_enabled (083): caller is a member AND enabled IS TRUE.
    ACCOUNT_WIDE: member("viewer") && world.flags[conv.accountId] === true,
    ASSIGNED_TO_ME: conv.assignee !== null && conv.assignee === user.id,
    UNASSIGNED: conv.assignee === null,
    QUEUE_MEMBER:
      conv.queueId !== null &&
      world.queueMembers.some(
        (qm) =>
          qm.queueId === conv.queueId &&
          qm.userId === user.id &&
          qm.accountId === conv.accountId &&
          qm.isActive,
      ),
    ASSIGNEE_IN_ACCOUNT: world.users.some(
      (u) => u.id === conv.assignee && u.accountId === conv.accountId,
    ),
  };
}

const selectUsing = toFormula(clause(policy("conversations.conversations_select").body, "using")!);
const updateUsing = toFormula(clause(policy("conversations.conversations_update").body, "using")!);
const updateCheck = toFormula(
  clause(policy("conversations.conversations_update").body, "with check")!,
);

const canSelect = (w: World, u: User, c: Conv) => evaluate(selectUsing, atomsFor(w, u, c));
const canUpdate = (w: World, u: User, c: Conv) => evaluate(updateUsing, atomsFor(w, u, c));
const passesCheck = (w: World, u: User, c: Conv) => evaluate(updateCheck, atomsFor(w, u, c));

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const SEGMENTED = "acc-segmented"; // no flag row at all
const FLAG_OFF = "acc-flag-off"; // explicit enabled = false

const araAgent: User = { id: "ara-agent", accountId: ARACAGI, role: "agent" };
const araViewer: User = { id: "ara-viewer", accountId: ARACAGI, role: "viewer" };
const araInactive: User = { id: "ara-off", accountId: ARACAGI, role: "agent", isActive: false };
const cohAgent: User = { id: "coh-agent", accountId: COHAMA, role: "agent" };
const cohViewer: User = { id: "coh-viewer", accountId: COHAMA, role: "viewer" };

const segOwner: User = { id: "seg-owner", accountId: SEGMENTED, role: "owner" };
const segAdmin: User = { id: "seg-admin", accountId: SEGMENTED, role: "admin" };
const segAgent: User = { id: "seg-agent", accountId: SEGMENTED, role: "agent" }; // active in Q1
const segAgentLapsed: User = { id: "seg-lapsed", accountId: SEGMENTED, role: "agent" }; // inactive in Q1
const segAgentNoQueue: User = { id: "seg-noqueue", accountId: SEGMENTED, role: "agent" };
const segViewer: User = { id: "seg-viewer", accountId: SEGMENTED, role: "viewer" }; // active in Q1
const segViewerNoQueue: User = { id: "seg-viewer-nq", accountId: SEGMENTED, role: "viewer" };
const offAgent: User = { id: "off-agent", accountId: FLAG_OFF, role: "agent" };
const offAdmin: User = { id: "off-admin", accountId: FLAG_OFF, role: "admin" };

const world: World = {
  flags: { [ARACAGI]: true, [COHAMA]: true, [FLAG_OFF]: false },
  users: [
    araAgent, araViewer, araInactive, cohAgent, cohViewer,
    segOwner, segAdmin, segAgent, segAgentLapsed, segAgentNoQueue, segViewer, segViewerNoQueue,
    offAgent, offAdmin,
  ],
  queueMembers: [
    { accountId: SEGMENTED, queueId: "seg-q1", userId: segAgent.id, isActive: true },
    { accountId: SEGMENTED, queueId: "seg-q1", userId: segViewer.id, isActive: true },
    { accountId: SEGMENTED, queueId: "seg-q1", userId: segAgentLapsed.id, isActive: false },
    { accountId: ARACAGI, queueId: "ara-q1", userId: araAgent.id, isActive: true },
    { accountId: FLAG_OFF, queueId: "off-q1", userId: offAgent.id, isActive: true },
    // Tenancy trap: a queue_members row of ANOTHER account pointing at seg-q2.
    { accountId: ARACAGI, queueId: "seg-q2", userId: araAgent.id, isActive: true },
  ],
};

const conv = (accountId: string, queueId: string | null, assignee: string | null): Conv => ({
  accountId,
  queueId,
  assignee,
});

/** One of each shape: no queue/no assignee, other queue, other assignee, own queue. */
const shapes = (accountId: string, ownQueue: string, colleague: string): Conv[] => [
  conv(accountId, null, null),
  conv(accountId, "some-other-queue", null),
  conv(accountId, null, colleague),
  conv(accountId, ownQueue, null),
];

const araConvs = shapes(ARACAGI, "ara-q1", "ara-colleague");
const cohConvs = shapes(COHAMA, "coh-q1", "coh-colleague");
const segConvs = [
  ...shapes(SEGMENTED, "seg-q1", segAgentNoQueue.id),
  conv(SEGMENTED, "seg-q2", null),
  conv(SEGMENTED, "seg-q2", segAgent.id),
];
const offConvs = shapes(FLAG_OFF, "off-q1", "off-colleague");
const everyConv = [...araConvs, ...cohConvs, ...segConvs, ...offConvs];

// ============================================================
// Structure of migration 083
// ============================================================

describe("083 — transaction and scope", () => {
  it("runs everything inside ONE explicit transaction with a lock_timeout", () => {
    const begin = sql083.indexOf("begin;");
    const commit = sql083.lastIndexOf("commit;");
    expect(sql083.match(/(?<![\w$])begin;/g)).toHaveLength(1);
    expect(sql083.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql083).not.toMatch(/\brollback\b/);
    expect(sql083.indexOf("set local lock_timeout")).toBeGreaterThan(begin);
    const stmts = [
      ...sql083.matchAll(/(?:drop|create)\s+policy\b|alter table|create or replace function|insert into/g),
    ].map((m) => m.index!);
    expect(stmts.length).toBeGreaterThan(0);
    for (const i of stmts) {
      expect(i).toBeGreaterThan(begin);
      expect(i).toBeLessThan(commit);
    }
  });

  it("only swaps conversations_select / conversations_update", () => {
    const touched = [
      ...sql083.matchAll(/(?:create|drop)\s+policy\s+(?:if\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)/g),
    ].map((m) => `${m[2]}.${m[1]}`);
    expect(new Set(touched)).toEqual(
      new Set(["conversations.conversations_select", "conversations.conversations_update"]),
    );
    expect(touched).toHaveLength(4);
  });

  it("leaves messages, INSERT/DELETE policies, triggers, queues and RLS switches alone", () => {
    expect(sql083).not.toContain("messages");
    expect(sql083).not.toContain("conversations_insert");
    expect(sql083).not.toContain("conversations_delete");
    expect(sql083).not.toContain("conversations_enforce_privilege_columns");
    expect(sql083).not.toMatch(/\b(create|drop|alter)\s+trigger\b/);
    expect(sql083).not.toMatch(/row\s+level\s+security/);
    expect(sql083).not.toMatch(/\b(delete\s+from|truncate)\b/);
    expect(sql083).not.toMatch(/\bupdate\s+public\.(conversations|queue_members|queues|contacts|tickets)\b/);
    expect(sql083).not.toMatch(/\binsert\s+into\s+public\.(conversations|queue_members|queues|contacts|tickets)\b/);
    expect(sql083).not.toMatch(/\bto\s+(anon|public)\b/);
  });

  it("never keys the RLS on a company name", () => {
    expect(sql083).not.toMatch(/outlet|aracagi|cohama|supermassa/);
    expect(sql083).not.toContain("accounts.name");
    expect(sql083).not.toContain("a.name");
  });
});

describe("083 — feature key catalog stays in sync (CHECK / RPC / TypeScript)", () => {
  it("ACCOUNT_FEATURE_KEYS includes inbox_account_wide", () => {
    expect(ACCOUNT_FEATURE_KEYS).toContain("inbox_account_wide");
  });

  it("the CHECK constraint allows exactly ACCOUNT_FEATURE_KEYS", () => {
    const m = /add constraint account_feature_flags_feature_key_check check \(feature_key = any \(array\[([^\]]+)\]/.exec(
      sql083,
    );
    expect(m).not.toBeNull();
    expect(quotedList(m![1])).toEqual([...ACCOUNT_FEATURE_KEYS]);
  });

  it("the old CHECK is dropped by catalog lookup, not by a presumed name", () => {
    expect(sql083).toContain("from pg_constraint con");
    expect(sql083).toContain("con.conrelid = 'public.account_feature_flags'::regclass");
    expect(sql083.indexOf("drop constraint %i")).toBeLessThan(
      sql083.indexOf("add constraint account_feature_flags_feature_key_check"),
    );
  });

  it("the RPC allowlist is exactly ACCOUNT_FEATURE_KEYS", () => {
    const def = functionDef(sql083, "platform_set_account_feature");
    const m = /p_feature_key <> all \(array\[([^\]]+)\]/.exec(def);
    expect(m).not.toBeNull();
    expect(quotedList(m![1])).toEqual([...ACCOUNT_FEATURE_KEYS]);
  });

  it("the RPC body is 071's, verbatim, apart from the new key", () => {
    const def071 = functionDef(readMigration(MIGRATION_071), "platform_set_account_feature")
      .replace(
        "array['multi_connection_enabled', 'business_units_enabled']",
        "array['multi_connection_enabled', 'business_units_enabled', 'inbox_account_wide']",
      )
      .replace(
        "must be one of: multi_connection_enabled, business_units_enabled'",
        "must be one of: multi_connection_enabled, business_units_enabled, inbox_account_wide'",
      );
    expect(functionDef(sql083, "platform_set_account_feature")).toBe(def071);
  });

  it("the RPC keeps SECURITY DEFINER, search_path, platform-admin gate, updated_by audit and grants", () => {
    const def = functionDef(sql083, "platform_set_account_feature");
    expect(def).toContain("security definer set search_path = public");
    expect(def).toContain("if v_caller_id is null then raise exception 'unauthorized'");
    expect(def).toContain("if not public.is_platform_admin() then raise exception 'forbidden'");
    expect(def).toContain("set enabled = p_enabled, updated_by = v_caller_id");
    expect(def).toContain("insert into public.platform_audit_log");
    const sig = "public.platform_set_account_feature(uuid, text, boolean)";
    expect(sql083).toContain(`alter function ${sig} owner to postgres;`);
    expect(sql083).toContain(`revoke execute on function ${sig} from public;`);
    expect(sql083).toContain(`revoke execute on function ${sig} from anon;`);
    expect(sql083).toContain(`grant execute on function ${sig} to authenticated;`);
  });
});

describe("083 — is_account_feature_enabled() is a narrow, read-only bridge", () => {
  const def = functionDef(sql083, "is_account_feature_enabled");
  const sig = "public.is_account_feature_enabled(uuid, text)";

  it("returns BOOLEAN; SQL, STABLE, SECURITY DEFINER, empty search_path", () => {
    expect(def).toContain(
      "returns boolean language sql stable security definer set search_path = '' as $$",
    );
  });

  it("is exactly: caller is a member of that account AND an enabled row exists", () => {
    const body = def.slice(def.indexOf("as $$") + 5, def.lastIndexOf("$$;")).trim();
    expect(body).toBe(
      "select public.is_account_member(p_account_id) and exists ( select 1 from public.account_feature_flags f where f.account_id = p_account_id and f.feature_key = p_feature_key and f.enabled is true );",
    );
  });

  it("cannot write or run dynamic SQL", () => {
    expect(def).not.toMatch(/\b(insert|update|delete|truncate|execute|alter|drop|grant)\b/);
  });

  it("is executable by authenticated only", () => {
    expect(sql083).toContain(`alter function ${sig} owner to postgres;`);
    expect(sql083).toContain(`revoke all on function ${sig} from public;`);
    expect(sql083).toContain(`revoke all on function ${sig} from anon;`);
    expect(sql083).toContain(`revoke all on function ${sig} from service_role;`);
    expect(sql083).toContain(`grant execute on function ${sig} to authenticated;`);
    expect(sql083.match(new RegExp(`grant [a-z ]+ on function ${sig.replace(/[.()]/g, "\\$&")}`, "g"))).toHaveLength(1);
  });

  it("is created before the policies that call it", () => {
    expect(sql083.indexOf("create or replace function public.is_account_feature_enabled(")).toBeLessThan(
      sql083.indexOf("create policy"),
    );
  });
});

describe("083 — the flag is seeded for ARACAGI and COHAMA only", () => {
  it("references exactly those two account ids", () => {
    const ids = sql083.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(ids)).toEqual(new Set([ARACAGI, COHAMA]));
  });

  it("writes account_feature_flags once, only inbox_account_wide = true, only for the targets, idempotently", () => {
    const inserts = sql083.match(/insert into public\.account_feature_flags[^;]*?(?:returning|;)/g) ?? [];
    // one inside the RPC (placeholder row for its own p_account_id) + the seed
    expect(inserts).toHaveLength(2);
    const seed = inserts.find((s) => s.includes("'inbox_account_wide'"))!;
    expect(seed).toContain("select a.id, 'inbox_account_wide', true from public.accounts a where a.id = any (v_targets)");
    expect(seed).toContain("on conflict (account_id, feature_key) do update set enabled = true");
    expect(sql083).not.toMatch(/'(multi_connection_enabled|business_units_enabled)',\s*true/);
  });
});

// ============================================================
// Effective policies after replaying every migration
// ============================================================

describe("083 — effective conversations policies", () => {
  it("select/update come from 083; insert is untouched; there is no delete policy", () => {
    expect(policy("conversations.conversations_select").file).toBe(MIGRATION_083);
    expect(policy("conversations.conversations_update").file).toBe(MIGRATION_083);
    expect(policy("conversations.conversations_insert").file).not.toBe(MIGRATION_083);
    expect([...policies.keys()].filter((k) => k.startsWith("conversations.")).sort()).toEqual([
      "conversations.conversations_insert",
      "conversations.conversations_select",
      "conversations.conversations_update",
    ]);
  });

  it("SELECT = member AND (account-wide OR admin OR assignee OR active queue member)", () => {
    expect(selectUsing).toBe("MEMBER and ( ACCOUNT_WIDE or ADMIN or ASSIGNED_TO_ME or QUEUE_MEMBER )");
  });

  it("UPDATE USING = agent+ AND (account-wide OR admin OR assignee OR active queue member)", () => {
    expect(updateUsing).toBe("AGENT and ( ACCOUNT_WIDE or ADMIN or ASSIGNED_TO_ME or QUEUE_MEMBER )");
  });

  it("UPDATE WITH CHECK is 076/082's: agent+ AND assignee NULL or a profile of the same account", () => {
    expect(updateCheck).toBe("AGENT and ( UNASSIGNED or ASSIGNEE_IN_ACCOUNT )");
  });

  it("no global policy and no queue_id IS NULL shortcut", () => {
    for (const key of ["conversations.conversations_select", "conversations.conversations_update"]) {
      const body = normalize(policy(key).body);
      expect(clause(body, "using")).not.toBe("true");
      expect(body).not.toContain("queue_id is null");
      expect(body).not.toMatch(/\bto\s+(anon|public)\b/);
    }
  });

  it("messages policies are still 017's and resolve visibility through conversations", () => {
    const select = policy("messages.messages_select");
    expect(select.file).toBe("017_account_sharing.sql");
    expect(clause(select.body, "using")).toContain(
      "from conversations c where c.id = messages.conversation_id",
    );
  });

  it("the column-protection trigger function is still 078's", () => {
    const defs = migrationFiles().filter((f) =>
      /create\s+or\s+replace\s+function\s+public\.conversations_enforce_privilege_columns/i.test(
        stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")),
      ),
    );
    expect(defs[defs.length - 1]).toBe("078_conversation_connection_tracking.sql");
  });
});

// ============================================================
// Behaviour — the SQL formulas evaluated against the model
// ============================================================

describe("083 — account-wide mode (flag = true)", () => {
  it("ARACAGI member sees every ARACAGI conversation regardless of queue/assignee", () => {
    for (const c of araConvs) {
      expect(canSelect(world, araAgent, c)).toBe(true);
      expect(canSelect(world, araViewer, c)).toBe(true);
    }
  });

  it("ARACAGI member sees nothing of COHAMA or of any other account", () => {
    for (const c of [...cohConvs, ...segConvs, ...offConvs]) {
      expect(canSelect(world, araAgent, c)).toBe(false);
      expect(canSelect(world, araViewer, c)).toBe(false);
      expect(canUpdate(world, araAgent, c)).toBe(false);
    }
  });

  it("COHAMA behaves the same: all of COHAMA, nothing else", () => {
    for (const c of cohConvs) {
      expect(canSelect(world, cohAgent, c)).toBe(true);
      expect(canSelect(world, cohViewer, c)).toBe(true);
    }
    for (const c of [...araConvs, ...segConvs, ...offConvs]) {
      expect(canSelect(world, cohAgent, c)).toBe(false);
      expect(canSelect(world, cohViewer, c)).toBe(false);
    }
  });

  it("agent+ can update any conversation of the own account (082); viewer cannot", () => {
    for (const c of araConvs) {
      expect(canUpdate(world, araAgent, c)).toBe(true);
      expect(canUpdate(world, araViewer, c)).toBe(false);
    }
    for (const c of cohConvs) {
      expect(canUpdate(world, cohAgent, c)).toBe(true);
      expect(canUpdate(world, cohViewer, c)).toBe(false);
    }
  });

  it("an inactive profile gets nothing even in an account-wide account", () => {
    for (const c of araConvs) {
      expect(canSelect(world, araInactive, c)).toBe(false);
      expect(canUpdate(world, araInactive, c)).toBe(false);
    }
  });
});

describe("083 — queue-based mode (flag absent)", () => {
  const unrouted = conv(SEGMENTED, null, null);
  const inMyQueue = conv(SEGMENTED, "seg-q1", null);
  const otherQueue = conv(SEGMENTED, "seg-q2", null);
  const otherQueueMine = conv(SEGMENTED, "seg-q2", segAgent.id);
  const assignedToColleague = conv(SEGMENTED, null, segAgentNoQueue.id);

  it("owner/admin see and can update every conversation of the own account", () => {
    for (const c of segConvs) {
      for (const u of [segOwner, segAdmin]) {
        expect(canSelect(world, u, c)).toBe(true);
        expect(canUpdate(world, u, c)).toBe(true);
      }
    }
  });

  it("agent sees a conversation assigned to them, even in a queue they are not in", () => {
    expect(canSelect(world, segAgent, otherQueueMine)).toBe(true);
    expect(canUpdate(world, segAgent, otherQueueMine)).toBe(true);
    expect(canSelect(world, segAgentNoQueue, assignedToColleague)).toBe(true);
  });

  it("agent sees a conversation of a queue they are an active member of", () => {
    expect(canSelect(world, segAgent, inMyQueue)).toBe(true);
    expect(canUpdate(world, segAgent, inMyQueue)).toBe(true);
  });

  it("agent does NOT see a conversation of another queue", () => {
    expect(canSelect(world, segAgent, otherQueue)).toBe(false);
    expect(canSelect(world, segAgentNoQueue, inMyQueue)).toBe(false);
  });

  it("agent does NOT see a conversation with no queue and no assignee", () => {
    expect(canSelect(world, segAgent, unrouted)).toBe(false);
    expect(canSelect(world, segAgentNoQueue, unrouted)).toBe(false);
  });

  it("agent does NOT see a conversation assigned to a colleague outside their queue", () => {
    expect(canSelect(world, segAgent, assignedToColleague)).toBe(false);
  });

  it("an inactive queue membership grants nothing", () => {
    expect(canSelect(world, segAgentLapsed, inMyQueue)).toBe(false);
    expect(canUpdate(world, segAgentLapsed, inMyQueue)).toBe(false);
  });

  it("viewer follows the same SELECT restriction", () => {
    expect(canSelect(world, segViewer, inMyQueue)).toBe(true);
    expect(canSelect(world, segViewer, conv(SEGMENTED, null, segViewer.id))).toBe(true);
    expect(canSelect(world, segViewer, otherQueue)).toBe(false);
    expect(canSelect(world, segViewer, unrouted)).toBe(false);
    for (const c of segConvs) expect(canSelect(world, segViewerNoQueue, c)).toBe(false);
  });

  it("viewer never gets UPDATE — not even on a conversation they can see", () => {
    for (const c of [...segConvs, conv(SEGMENTED, null, segViewer.id)]) {
      expect(canUpdate(world, segViewer, c)).toBe(false);
      expect(passesCheck(world, segViewer, c)).toBe(false);
    }
  });

  it("agent gets no UPDATE on another sector's / unassigned conversation", () => {
    expect(canUpdate(world, segAgent, otherQueue)).toBe(false);
    expect(canUpdate(world, segAgent, unrouted)).toBe(false);
    expect(canUpdate(world, segAgent, assignedToColleague)).toBe(false);
    expect(canUpdate(world, segAgentNoQueue, inMyQueue)).toBe(false);
  });

  it("UPDATE visibility never exceeds SELECT visibility, for anyone", () => {
    for (const u of world.users) {
      for (const c of everyConv) {
        if (canUpdate(world, u, c)) expect(canSelect(world, u, c)).toBe(true);
      }
    }
  });
});

describe("083 — WITH CHECK (unchanged from 076/082) in both modes", () => {
  it("agent may hand a conversation to a colleague of the same account or unassign it", () => {
    expect(passesCheck(world, segAgent, conv(SEGMENTED, "seg-q1", segAgentNoQueue.id))).toBe(true);
    expect(passesCheck(world, segAgent, conv(SEGMENTED, "seg-q1", null))).toBe(true);
    expect(passesCheck(world, araAgent, conv(ARACAGI, null, araViewer.id))).toBe(true);
  });

  it("assigning to a user of another account is rejected in both modes", () => {
    expect(passesCheck(world, segAgent, conv(SEGMENTED, "seg-q1", araAgent.id))).toBe(false);
    expect(passesCheck(world, araAgent, conv(ARACAGI, null, cohAgent.id))).toBe(false);
  });
});

describe("083 — feature flag semantics", () => {
  const unrouted = (accountId: string) => conv(accountId, null, null);

  it("absent → queue-based", () => {
    expect(canSelect(world, segAgent, unrouted(SEGMENTED))).toBe(false);
  });

  it("false → queue-based (identical to absent)", () => {
    expect(canSelect(world, offAgent, unrouted(FLAG_OFF))).toBe(false);
    expect(canSelect(world, offAgent, conv(FLAG_OFF, "off-q1", null))).toBe(true);
    expect(canSelect(world, offAgent, conv(FLAG_OFF, "other", null))).toBe(false);
    expect(canUpdate(world, offAgent, unrouted(FLAG_OFF))).toBe(false);
    expect(canSelect(world, offAdmin, unrouted(FLAG_OFF))).toBe(true);
  });

  it("true → account-wide", () => {
    const flipped: World = { ...world, flags: { ...world.flags, [FLAG_OFF]: true } };
    expect(canSelect(flipped, offAgent, unrouted(FLAG_OFF))).toBe(true);
    expect(canUpdate(flipped, offAgent, unrouted(FLAG_OFF))).toBe(true);
  });

  it("turning the flag off returns an account to queue-based", () => {
    const flipped: World = { ...world, flags: { ...world.flags, [ARACAGI]: false } };
    expect(canSelect(flipped, araAgent, unrouted(ARACAGI))).toBe(false);
    expect(canSelect(flipped, araAgent, conv(ARACAGI, "ara-q1", null))).toBe(true);
  });

  it("another account's flag never widens this account", () => {
    // ARACAGI is account-wide; a segmented agent is unaffected by it.
    expect(canSelect(world, segAgent, unrouted(SEGMENTED))).toBe(false);
  });
});

describe("083 — no cross-account access in any combination", () => {
  it("no user can select, update or pass WITH CHECK on a conversation of another account", () => {
    for (const u of world.users) {
      for (const c of everyConv) {
        if (u.accountId === c.accountId) continue;
        // Worst case: the foreign conversation is assigned to this very user.
        for (const target of [c, { ...c, assignee: u.id }]) {
          expect(canSelect(world, u, target)).toBe(false);
          expect(canUpdate(world, u, target)).toBe(false);
          expect(passesCheck(world, u, target)).toBe(false);
        }
      }
    }
  });

  it("a queue_members row from another account does not open the queue", () => {
    // araAgent has a (rogue) ARACAGI-scoped membership row for seg-q2.
    expect(canSelect(world, araAgent, conv(SEGMENTED, "seg-q2", null))).toBe(false);
  });
});
