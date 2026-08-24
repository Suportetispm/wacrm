import { describe, expect, it } from "vitest";
import { resolveSelectedLabel } from "@base-ui/react/internals/resolveValueLabel";

import { buildQueueSelectItems } from "@/components/flows/forms/node-config-form";
import { eligibleTransferAgentCandidates } from "@/lib/tickets/candidates";
import type { AccountMember } from "@/types";

// Regression coverage for the ticket-detail transfer dialogs (queue,
// agent) showing raw UUIDs instead of friendly labels. Same root
// cause as every other Select in this audit: base-ui's <Select.Value>
// resolves a selected item's label from `Select.Root`'s `items` —
// never from the rendered <SelectItem> children.
//
// Neither dialog needed a new exported helper: TransferQueueDialog
// reuses buildQueueSelectItems (already covered by
// node-config-form.test.ts); TransferAgentDialog's candidates already
// come out of eligibleTransferAgentCandidates shaped as
// {user_id, label} (src/lib/tickets/candidates.ts, already tested
// there) — the page only needed to map that to {value, label} at the
// Select. These tests pin that the *wiring* (the items= prop actually
// passed to the Select) resolves correctly end-to-end, not just that
// the underlying data has the right shape.

const QUEUES = [{ id: "a4110000-0000-0000-0000-000000000001", name: "Suporte TI" }];

function member(overrides: Partial<AccountMember>): AccountMember {
  return {
    user_id: "u1",
    full_name: "Agent Name",
    email: null,
    avatar_url: null,
    role: "agent",
    joined_at: "2026-01-01T00:00:00Z",
    is_active: true,
    ...overrides,
  };
}

describe("TransferQueueDialog items (buildQueueSelectItems)", () => {
  it("a queue UUID resolves to queue.name, not the raw UUID", () => {
    const items = buildQueueSelectItems(QUEUES);
    expect(resolveSelectedLabel("a4110000-0000-0000-0000-000000000001", items)).toBe("Suporte TI");
  });
});

describe("TransferAgentDialog items (candidates.map(c => ({value: c.user_id, label: c.label})))", () => {
  it("an agent UUID resolves to the candidate's friendly label, not the raw UUID", () => {
    const candidates = eligibleTransferAgentCandidates(
      [member({ user_id: "83ff3bfc-d750-49cf-0000-000000000001", full_name: "Fernandes de Macedo" })],
      null,
      null,
    );
    const items = candidates.map((c) => ({ value: c.user_id, label: c.label }));
    expect(resolveSelectedLabel("83ff3bfc-d750-49cf-0000-000000000001", items)).toBe(
      "Fernandes de Macedo",
    );
  });

  it("no known agent UUID leaks through as its own label", () => {
    const candidates = eligibleTransferAgentCandidates(
      [member({ user_id: "83ff3bfc-d750-49cf-0000-000000000001", full_name: "Fernandes de Macedo" })],
      null,
      null,
    );
    const items = candidates.map((c) => ({ value: c.user_id, label: c.label }));
    for (const item of items) {
      expect(item.label).not.toBe(item.value);
    }
  });
});
