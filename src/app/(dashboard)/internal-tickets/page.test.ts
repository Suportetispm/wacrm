import { describe, expect, it } from "vitest";
import { resolveSelectedLabel } from "@base-ui/react/internals/resolveValueLabel";

import { buildCatalogSelectItems } from "@/lib/internal-tickets/select-items";
import { buildMemberSelectItems } from "@/lib/account/members";

// Regression coverage for the Internal Tickets list's assignee filter
// (a member picker, not a plain catalog) — pins the exact `items`
// composition used in page.tsx: `[{value:"all",...}, ...buildMemberSelectItems(members)]`.
// The underlying helpers (buildMemberSelectItems, buildCatalogSelectItems)
// already have their own full test suites (Etapa 2, and
// select-items.test.ts in this etapa) — this only proves the specific
// wiring used on this page resolves correctly end-to-end.

const MEMBERS = [
  { user_id: "83ff3bfc-d750-49cf-0000-000000000001", full_name: "Fernandes de Macedo", email: null },
];

describe("Internal Tickets list filters — items composition", () => {
  it("assignee filter: a member UUID resolves to the member's name, not the raw UUID", () => {
    const items = [{ value: "all", label: "Todos" }, ...buildMemberSelectItems(MEMBERS)];
    expect(resolveSelectedLabel("83ff3bfc-d750-49cf-0000-000000000001", items)).toBe(
      "Fernandes de Macedo",
    );
  });

  it('assignee filter: "all" resolves to "Todos", not the literal string', () => {
    const items = [{ value: "all", label: "Todos" }, ...buildMemberSelectItems(MEMBERS)];
    expect(resolveSelectedLabel("all", items)).toBe("Todos");
  });

  it("status filter: a status UUID resolves to status.name via the same generic catalog helper", () => {
    const statuses = [{ id: "s1", name: "Aberto" }];
    const items = [{ value: "all", label: "Todos" }, ...buildCatalogSelectItems(statuses)];
    expect(resolveSelectedLabel("s1", items)).toBe("Aberto");
  });
});
