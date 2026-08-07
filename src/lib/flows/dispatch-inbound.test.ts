import { beforeEach, describe, expect, it, vi } from "vitest";

// dispatchInboundToFlows is the webhook's entry point into the flow
// runner. This file covers only the accounts.is_active gate added in
// 047_platform_account_management.sql — the runner's own decision
// logic (matching, advancing nodes, etc.) is covered by engine.test.ts.

const h = vi.hoisted(() => ({
  state: {
    accountActive: true,
    fromCalls: [] as string[],
  },
}));

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      h.state.fromCalls.push(table);
      const empty = { data: table === "accounts" ? { is_active: h.state.accountActive } : [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(empty),
        then: (onF: (v: unknown) => unknown) => Promise.resolve(empty).then(onF),
      };
      return chain;
    },
  }),
}));

import { dispatchInboundToFlows } from "./engine";

beforeEach(() => {
  h.state.accountActive = true;
  h.state.fromCalls = [];
});

describe("dispatchInboundToFlows — inactive account (accounts.is_active = false)", () => {
  it("skips entirely — returns no_match without touching flow_runs/flows", async () => {
    h.state.accountActive = false;

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "hi", meta_message_id: "m1" },
      isFirstInboundMessage: false,
    });

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(h.state.fromCalls).toContain("accounts");
    expect(h.state.fromCalls).not.toContain("flow_runs");
    expect(h.state.fromCalls).not.toContain("flows");
  });

  it("an active account proceeds past the gate (no regression)", async () => {
    h.state.accountActive = true;

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "hi", meta_message_id: "m1" },
      isFirstInboundMessage: false,
    });

    // No active run, no matching flow — same neutral outcome, but
    // this time because the lookups genuinely found nothing, not
    // because the gate short-circuited first.
    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(h.state.fromCalls).toContain("flow_runs");
  });
});
