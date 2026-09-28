import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { matchesInboxFilters, type InboxFilters } from "./conversations";
import type { Conversation } from "@/types";

/**
 * Migration 082 — Inbox visibility is account-wide.
 *
 * There is no Postgres in the unit-test environment, so the RLS side is
 * checked statically: every migration is replayed in filename order and
 * the LAST `CREATE POLICY` per (table, policy) is the effective one —
 * exactly what the database ends up with. The behavioral proof against a
 * real database (scenarios A–H, with impersonated JWTs) lives in
 * supabase/validation/082_inbox_account_wide_visibility_check.sql.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const MIGRATION_082 = "082_inbox_account_wide_visibility.sql";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Balanced-paren body of the first `<keyword> (` after `from`, or null. */
function clause(body: string, keyword: "using" | "with check"): string | null {
  const re = new RegExp(`\\b${keyword.replace(" ", "\\s+")}\\s*\\(`, "i");
  const match = re.exec(body);
  if (!match) return null;
  let depth = 1;
  const start = match.index + match[0].length;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    if (depth === 0) return normalize(body.slice(start, i));
  }
  return null;
}

interface PolicyDef {
  file: string;
  body: string;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Effective policy per `${table}.${policy}` after replaying every migration in order. */
function effectivePolicies(): Map<string, PolicyDef> {
  const policies = new Map<string, PolicyDef>();
  // CREATE and DROP replayed in source order — 017 drops 001's legacy
  // "Users can manage own conversations", 075 drops conversations_delete.
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

const policies = effectivePolicies();
const sql082 = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, MIGRATION_082), "utf8"));

function policy(key: string): PolicyDef {
  const def = policies.get(key);
  if (!def) throw new Error(`policy ${key} not found in migrations`);
  return def;
}

describe("082 — conversations_select is account-wide", () => {
  const select = policy("conversations.conversations_select");

  it("is defined last by migration 082", () => {
    expect(select.file).toBe(MIGRATION_082);
  });

  it("only requires active membership of the conversation's own account", () => {
    expect(clause(select.body, "using")).toBe("public.is_account_member(account_id)");
  });

  it("no longer gates on queue membership or assignee (A: sem fila / sem responsável / outro agent / outra fila)", () => {
    const using = clause(select.body, "using")!;
    expect(using).not.toContain("queue_members");
    expect(using).not.toContain("assigned_agent_id");
    expect(using).not.toContain("queue_id");
  });
});

describe("082 — conversations_update follows the same scope", () => {
  const update = policy("conversations.conversations_update");

  it("is defined last by migration 082", () => {
    expect(update.file).toBe(MIGRATION_082);
  });

  it("USING = agent+ of the same account, without queue/assignee gating", () => {
    expect(clause(update.body, "using")).toBe("public.is_account_member(account_id, 'agent')");
  });

  it("keeps 076's WITH CHECK: assignee must be a profile of the same account", () => {
    const check = clause(update.body, "with check")!;
    expect(check).toContain("public.is_account_member(account_id, 'agent')");
    expect(check).toContain("assigned_agent_id is null");
    expect(check).toContain("from public.profiles p where");
    expect(check).toContain("p.user_id = conversations.assigned_agent_id");
    expect(check).toContain("p.account_id = conversations.account_id");
  });
});

describe("082 — isolation invariants (B/C/D/E)", () => {
  it("every effective conversations policy is scoped by is_account_member(account_id, …)", () => {
    const convPolicies = [...policies.entries()].filter(([key]) => key.startsWith("conversations."));
    expect(convPolicies.map(([key]) => key).sort()).toEqual([
      "conversations.conversations_insert",
      "conversations.conversations_select",
      "conversations.conversations_update",
    ]);
    for (const [, def] of convPolicies) {
      const text = normalize(def.body);
      expect(text).toMatch(/is_account_member\(account_id/);
      expect(clause(def.body, "using") ?? "").not.toBe("true");
      expect(clause(def.body, "with check") ?? "").not.toBe("true");
    }
  });

  it("is_account_member still requires same account + active profile + active account", () => {
    const file048 = "048_platform_user_management.sql";
    const sql048 = readFileSync(join(MIGRATIONS_DIR, file048), "utf8");
    // 048 is the last definition — no later migration redefines the body.
    const later = migrationFiles().filter((f) => f > file048);
    for (const f of later) {
      const text = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      expect(text).not.toMatch(/create\s+or\s+replace\s+function\s+(public\.)?is_account_member/i);
    }
    const body = normalize(stripSqlComments(sql048));
    expect(body).toContain("p.user_id = auth.uid()");
    expect(body).toContain("p.account_id = target_account_id");
    expect(body).toContain("and p.is_active");
    expect(body).toContain("and a.is_active");
  });

  it("082 only touches conversations_select / conversations_update", () => {
    const touched = [...sql082.matchAll(/(?:create|drop)\s+policy\s+(?:if\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)/gi)]
      .map((m) => `${m[2]}.${m[1]}`.toLowerCase());
    expect(new Set(touched)).toEqual(
      new Set(["conversations.conversations_select", "conversations.conversations_update"]),
    );
  });

  it("every single-letter table alias used in 082 is declared (regression: 42P01 missing FROM-clause entry)", () => {
    const text = normalize(sql082);
    const declared = new Set(
      [...text.matchAll(/\b(?:from|join)\s+(?:public\.)?\w+\s+(?:as\s+)?([a-z])\b/g)].map((m) => m[1]),
    );
    const used = new Set([...text.matchAll(/(?<![\w.])([a-z])\.\w+/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const alias of used) expect(declared, `alias "${alias}" used but not declared`).toContain(alias);
  });

  it("swaps both policies inside ONE explicit transaction (no window without a policy)", () => {
    const text = normalize(sql082);
    const begin = text.indexOf("begin;");
    const commit = text.lastIndexOf("commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(text.match(/\bbegin;/g)).toHaveLength(1);
    expect(text.match(/\bcommit;/g)).toHaveLength(1);
    expect(text).not.toMatch(/\brollback\b/);
    const stmts = [...text.matchAll(/(?:drop|create)\s+policy\b/g)].map((m) => m.index!);
    expect(stmts).toHaveLength(4);
    for (const i of stmts) {
      expect(i).toBeGreaterThan(begin);
      expect(i).toBeLessThan(commit);
    }
    expect(text).toContain("set local lock_timeout");
  });

  it("082 never disables RLS, never writes rows, never references service_role", () => {
    const text = normalize(sql082);
    expect(text).not.toMatch(/disable\s+row\s+level\s+security/);
    expect(text).not.toMatch(/\bupdate\s+(public\.)?\w+\s+set\b/);
    expect(text).not.toMatch(/\binsert\s+into\b/);
    expect(text).not.toMatch(/\bdelete\s+from\b/);
    expect(text).not.toMatch(/\btruncate\b/);
    expect(text).not.toContain("service_role");
    expect(text).not.toMatch(/\bto\s+(anon|public)\b/);
  });

  it("queue_id stays write-protected for authenticated (trigger not redefined by 082)", () => {
    expect(sql082).not.toMatch(/conversations_enforce_privilege_columns/i);
    const defs = migrationFiles().filter((f) =>
      /create\s+or\s+replace\s+function\s+public\.conversations_enforce_privilege_columns/i.test(
        stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")),
      ),
    );
    const last = normalize(stripSqlComments(readFileSync(join(MIGRATIONS_DIR, defs[defs.length - 1]), "utf8")));
    expect(last).toContain("new.queue_id is distinct from old.queue_id");
    expect(last).toContain("new.account_id is distinct from old.account_id");
  });
});

describe("082 — messages follow the conversation/account isolation (G)", () => {
  it("messages_select: conversation of an account the caller is an active member of", () => {
    const select = policy("messages.messages_select");
    expect(select.file).toBe("017_account_sharing.sql");
    const using = clause(select.body, "using")!;
    expect(using).toContain("from conversations c where c.id = messages.conversation_id");
    expect(using).toContain("is_account_member(c.account_id)");
  });

  it("messages_modify: agent+ of the conversation's account (send persistence)", () => {
    const modify = policy("messages.messages_modify");
    expect(clause(modify.body, "using")).toContain("is_account_member(c.account_id, 'agent')");
    expect(clause(modify.body, "with check")).toContain("is_account_member(c.account_id, 'agent')");
  });
});

describe("082 — realtime keeps publishing conversations and messages (H)", () => {
  it("both tables are added to supabase_realtime and never dropped", () => {
    const all = migrationFiles()
      .map((f) => stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")))
      .join("\n");
    expect(all).toMatch(/alter\s+publication\s+supabase_realtime\s+add\s+table\s+messages/i);
    expect(all).toMatch(/alter\s+publication\s+supabase_realtime\s+add\s+table\s+conversations/i);
    expect(all).not.toMatch(/alter\s+publication\s+supabase_realtime\s+drop\s+table\s+(public\.)?(messages|conversations)/i);
  });
});

// ------------------------------------------------------------
// F — "atribuídas a mim" / por agente / sem responsável are UI
// filters over the full account list; with none selected, every
// conversation the RLS returned is shown regardless of queue/assignee.
// ------------------------------------------------------------
describe("082 — Inbox filters narrow the account-wide list, never gate it (F)", () => {
  const base = {
    account_id: "acc-a",
    contact_id: "ct",
    user_id: "owner",
    status: "pending",
    unread_count: 0,
    last_message_text: null,
    last_message_at: null,
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
  };
  const list = [
    { ...base, id: "no-queue-no-agent", queue_id: null, assigned_agent_id: undefined },
    { ...base, id: "mine", queue_id: null, assigned_agent_id: "me" },
    { ...base, id: "other-agent", queue_id: null, assigned_agent_id: "other" },
    { ...base, id: "other-queue", queue_id: "queue-not-mine", assigned_agent_id: undefined },
  ] as unknown as Conversation[];

  const run = (filters: Partial<InboxFilters>) =>
    list
      .filter((c) =>
        matchesInboxFilters(c, { status: "all", unreadOnly: false, assigneeId: null, ...filters }),
      )
      .map((c) => c.id);

  it("no filter → every conversation, including unassigned, other agent's and other queue's", () => {
    expect(run({})).toEqual(["no-queue-no-agent", "mine", "other-agent", "other-queue"]);
  });

  it("'atribuídas a mim' (assigneeId = self) narrows to my conversations only", () => {
    expect(run({ assigneeId: "me" })).toEqual(["mine"]);
  });

  it("filter by another agent narrows to that agent", () => {
    expect(run({ assigneeId: "other" })).toEqual(["other-agent"]);
  });

  it("'sem responsável' narrows to unassigned, regardless of queue", () => {
    expect(run({ assigneeId: "unassigned" })).toEqual(["no-queue-no-agent", "other-queue"]);
  });
});
