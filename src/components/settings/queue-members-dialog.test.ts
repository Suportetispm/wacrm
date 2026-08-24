import { describe, expect, it } from "vitest";
import { resolveSelectedLabel } from "@base-ui/react/internals/resolveValueLabel";
import { buildQueueMemberRoleSelectItems } from "./queue-members-dialog";

// Regression coverage for the per-member "role_in_queue" Select
// showing the raw "agent"/"supervisor" string instead of a translated
// label — same root cause as every other Select in this audit: base-ui
// resolves the CLOSED trigger's label from `items`, never from the
// rendered <SelectItem> children.

describe("buildQueueMemberRoleSelectItems", () => {
  const t = (key: "roleAgent" | "roleSupervisor") =>
    ({ roleAgent: "Atendente", roleSupervisor: "Supervisor" })[key];

  it("maps agent/supervisor to the caller's translated labels — value stays the technical enum", () => {
    expect(buildQueueMemberRoleSelectItems(t)).toEqual([
      { value: "agent", label: "Atendente" },
      { value: "supervisor", label: "Supervisor" },
    ]);
  });

  it("no known role_in_queue enum leaks through as its own label", () => {
    for (const item of buildQueueMemberRoleSelectItems(t)) {
      expect(item.label).not.toBe(item.value);
    }
  });

  it("resolveSelectedLabel (real @base-ui/react resolver) resolves 'agent' to its translated label, not the raw string", () => {
    const items = buildQueueMemberRoleSelectItems(t);
    expect(resolveSelectedLabel("agent", items)).toBe("Atendente");
    expect(resolveSelectedLabel("supervisor", items)).toBe("Supervisor");
  });
});
