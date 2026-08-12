import { describe, it, expect } from "vitest";
import {
  PENDING_REVERT_MINUTES,
  shouldRevertToPending,
  isOpenTransitionEligible,
} from "./auto-status";
import type { ConversationStatus } from "@/types";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("shouldRevertToPending", () => {
  it("reverts when the last message is from the customer and 10+ minutes have passed", () => {
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "customer", created_at: minutesAgo(10) },
        NOW,
      ),
    ).toBe(true);
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "customer", created_at: minutesAgo(30) },
        NOW,
      ),
    ).toBe(true);
  });

  it("does not revert before the 10-minute threshold", () => {
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "customer", created_at: minutesAgo(9) },
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "customer", created_at: minutesAgo(0) },
        NOW,
      ),
    ).toBe(false);
  });

  it("never reverts when the last message is from the agent, regardless of elapsed time", () => {
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "agent", created_at: minutesAgo(999) },
        NOW,
      ),
    ).toBe(false);
  });

  it("never reverts when the last message is from the bot — answered counts even without a human", () => {
    expect(
      shouldRevertToPending(
        { status: "in_progress" },
        { sender_type: "bot", created_at: minutesAgo(999) },
        NOW,
      ),
    ).toBe(false);
  });

  it("never reverts when there is no last message at all", () => {
    expect(shouldRevertToPending({ status: "in_progress" }, null, NOW)).toBe(
      false,
    );
  });

  it("only applies to 'in_progress' — pending/waiting_customer/closed/finalized never revert on time alone", () => {
    const statuses: ConversationStatus[] = [
      "pending",
      "waiting_customer",
      "closed",
      "finalized",
    ];
    for (const status of statuses) {
      expect(
        shouldRevertToPending(
          { status },
          { sender_type: "customer", created_at: minutesAgo(999) },
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("PENDING_REVERT_MINUTES is 10, matching the product rule", () => {
    expect(PENDING_REVERT_MINUTES).toBe(10);
  });
});

describe("isOpenTransitionEligible", () => {
  it("agent opening a pending conversation is eligible", () => {
    expect(isOpenTransitionEligible({ status: "pending" }, "agent")).toBe(
      true,
    );
  });

  it("admin/owner opening a pending conversation is NOT eligible — view only, never auto-claims", () => {
    expect(isOpenTransitionEligible({ status: "pending" }, "admin")).toBe(
      false,
    );
    expect(isOpenTransitionEligible({ status: "pending" }, "owner")).toBe(
      false,
    );
  });

  it("viewer is never eligible", () => {
    expect(isOpenTransitionEligible({ status: "pending" }, "viewer")).toBe(
      false,
    );
  });

  it("null role (still loading) is never eligible", () => {
    expect(isOpenTransitionEligible({ status: "pending" }, null)).toBe(false);
  });

  it("agent opening a non-pending conversation is NOT eligible", () => {
    const statuses: ConversationStatus[] = [
      "in_progress",
      "waiting_customer",
      "closed",
      "finalized",
    ];
    for (const status of statuses) {
      expect(isOpenTransitionEligible({ status }, "agent")).toBe(false);
    }
  });
});
