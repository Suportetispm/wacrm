import { describe, expect, it } from "vitest";
import { buildQueueSelectItems, resolveQueueSelection } from "./node-config-form";

// Regression coverage for the "Setor picker shows the raw UUID
// instead of the queue name" bug (queue_menu — 2026-08-21).
//
// Root cause: base-ui's <Select.Value> (the CLOSED trigger's
// displayed text) resolves a selected item's label from the `items`
// list passed to <Select.Root> — never from the rendered
// <SelectItem> children. QueueMenuForm's two Selects (per-option
// queue picker, fallback picker) weren't passing `items`, so once a
// queue was picked the trigger fell back to showing the raw queue_id.
//
// These two functions are the exact data QueueMenuForm feeds into
// (a) the Select's `items` prop, which is what fixes the display bug,
// and (b) the config patch persisted to flow_nodes.config — so
// covering them here pins both halves of the bug report: "texto
// mostrado" and "config.options[].label" are backed by the same
// `queue.name` lookup and can never diverge from it.

const QUEUES = [
  { id: "a4110000-0000-0000-0000-000000000001", name: "RH" },
  { id: "05ef0000-0000-0000-0000-000000000002", name: "Suporte TI" },
  { id: "c7170000-0000-0000-0000-000000000003", name: "Fiscal" },
];

describe("buildQueueSelectItems", () => {
  it("maps queue_id to `value` and queue.name to `label` — never swapped", () => {
    const items = buildQueueSelectItems(QUEUES);
    expect(items).toEqual([
      { value: "a4110000-0000-0000-0000-000000000001", label: "RH" },
      { value: "05ef0000-0000-0000-0000-000000000002", label: "Suporte TI" },
      { value: "c7170000-0000-0000-0000-000000000003", label: "Fiscal" },
    ]);
  });

  it("every item's label is the queue name, never its own id (no UUID as label)", () => {
    const items = buildQueueSelectItems(QUEUES);
    for (const item of items) {
      expect(item.label).not.toBe(item.value);
      expect(item.label).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });

  it("returns an empty list for an empty queue list", () => {
    expect(buildQueueSelectItems([])).toEqual([]);
  });
});

describe("resolveQueueSelection", () => {
  it("persists queue_id = the selected queue's id, label = its name", () => {
    const patch = resolveQueueSelection(QUEUES, "05ef0000-0000-0000-0000-000000000002");
    expect(patch.queue_id).toBe("05ef0000-0000-0000-0000-000000000002");
    expect(patch.label).toBe("Suporte TI");
  });

  it("the persisted label is never the raw UUID when the queue is known", () => {
    for (const q of QUEUES) {
      const patch = resolveQueueSelection(QUEUES, q.id);
      expect(patch.label).toBe(q.name);
      expect(patch.label).not.toBe(patch.queue_id);
    }
  });

  it("falls back to an empty label for an unknown queue_id (defensive — picker only offers known queues)", () => {
    const patch = resolveQueueSelection(QUEUES, "ghost-id");
    expect(patch.queue_id).toBe("ghost-id");
    expect(patch.label).toBe("");
  });
});

// AssignQueueForm (the assign_queue node — 2026-08-21 audit) has the
// EXACT same missing-`items` bug, confirmed by reading its Select
// before the fix: no `items` prop, so the closed trigger fell back to
// the raw queue_id. Fixed by reusing `buildQueueSelectItems` (same
// function QueueMenuForm's fix above uses) rather than duplicating the
// mapping — AssignQueueForm's onValueChange persists `queue_id` alone
// (AssignQueueNodeConfig has no `label` field, unlike QueueMenuOption,
// and adding one would be a schema/functional change out of scope for
// a display-only fix), so `resolveQueueSelection` isn't applicable
// there — only the `items` list matters for this bug.
describe("AssignQueueForm's Select — same items-list fix, reusing buildQueueSelectItems", () => {
  it("the persisted value (queue_id) and the displayed label (queue.name) never collapse into the same string", () => {
    // Mirrors AssignQueueForm's onValueChange: `(v) => onUpdateConfig({ queue_id: v })`
    // — queue_id persisted is exactly the selected item's `value`.
    const items = buildQueueSelectItems(QUEUES);
    for (const q of QUEUES) {
      const selectedItem = items.find((it) => it.value === q.id);
      const persistedQueueId = selectedItem?.value; // what AssignQueueForm writes to config.queue_id
      const displayedLabel = selectedItem?.label; // what the Select trigger now shows
      expect(persistedQueueId).toBe(q.id);
      expect(displayedLabel).toBe(q.name);
      expect(displayedLabel).not.toBe(persistedQueueId);
      expect(displayedLabel).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });
});
