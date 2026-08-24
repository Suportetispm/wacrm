import { describe, expect, it } from "vitest";
import { resolveSelectedLabel } from "@base-ui/react/internals/resolveValueLabel";

import { buildPrioritySelectItems } from "./page";
import { buildQueueSelectItems } from "@/components/flows/forms/node-config-form";
import { buildMemberSelectItems } from "@/lib/account/members";

// Regression coverage for the Tickets list/filters showing raw
// UUIDs/enums instead of friendly labels (Etapa 3 — tickets). Root
// cause, same as every other Select in this audit: base-ui's
// <Select.Value> (the CLOSED trigger's displayed text) resolves a
// selected item's label from the `items` list passed to
// <Select.Root> — never from the rendered <SelectItem> children.

const QUEUES = [
  { id: "a4110000-0000-0000-0000-000000000001", name: "Suporte TI" },
  { id: "05ef0000-0000-0000-0000-000000000002", name: "Financeiro" },
];

const MEMBERS = [
  { user_id: "83ff3bfc-d750-49cf-0000-000000000001", full_name: "Fernandes de Macedo", email: null },
];

const tPriority = (key: "priorityLow" | "priorityNormal" | "priorityHigh" | "priorityUrgent") =>
  ({
    priorityLow: "Baixa",
    priorityNormal: "Normal",
    priorityHigh: "Alta",
    priorityUrgent: "Urgente",
  })[key];

describe("buildPrioritySelectItems", () => {
  it("maps low/normal/high/urgent to the caller's translated labels — value stays the technical enum", () => {
    expect(buildPrioritySelectItems(tPriority)).toEqual([
      { value: "low", label: "Baixa" },
      { value: "normal", label: "Normal" },
      { value: "high", label: "Alta" },
      { value: "urgent", label: "Urgente" },
    ]);
  });

  it("no known priority enum leaks through as its own label", () => {
    for (const item of buildPrioritySelectItems(tPriority)) {
      expect(item.label).not.toBe(item.value);
    }
  });
});

describe("resolveSelectedLabel (real @base-ui/react resolver) against the tickets filters' items", () => {
  it("a queue UUID resolves to queue.name, not the raw UUID", () => {
    const items = [{ value: "all", label: "Todas" }, ...buildQueueSelectItems(QUEUES)];
    expect(resolveSelectedLabel("a4110000-0000-0000-0000-000000000001", items)).toBe("Suporte TI");
  });

  it("a member UUID resolves to the member's name, not the raw UUID", () => {
    const items = [{ value: "all", label: "Todos" }, ...buildMemberSelectItems(MEMBERS)];
    expect(resolveSelectedLabel("83ff3bfc-d750-49cf-0000-000000000001", items)).toBe(
      "Fernandes de Macedo",
    );
  });

  it("a priority enum resolves to its translated label, not the raw 'high' string", () => {
    const items = [{ value: "all", label: "Todas" }, ...buildPrioritySelectItems(tPriority)];
    expect(resolveSelectedLabel("high", items)).toBe("Alta");
  });

  it('"all" resolves to the translated "Todas"/"Todos", not the literal string "all", for every one of the 3 filters', () => {
    expect(
      resolveSelectedLabel("all", [{ value: "all", label: "Todas" }, ...buildQueueSelectItems(QUEUES)]),
    ).toBe("Todas");
    expect(
      resolveSelectedLabel("all", [{ value: "all", label: "Todos" }, ...buildMemberSelectItems(MEMBERS)]),
    ).toBe("Todos");
    expect(
      resolveSelectedLabel("all", [{ value: "all", label: "Todas" }, ...buildPrioritySelectItems(tPriority)]),
    ).toBe("Todas");
  });

  it("DOCUMENTED, NOT FIXED (per this step's scope): an orphan queue_id with no matching item still falls back to the raw value itself", () => {
    const items = [{ value: "all", label: "Todas" }, ...buildQueueSelectItems(QUEUES)];
    const orphanUuid = "ffffffff-0000-0000-0000-000000000000";
    expect(resolveSelectedLabel(orphanUuid, items)).toBe(orphanUuid);
  });
});
