import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyActiveTicketVisibility,
  resolveActiveTicketVisibility,
} from "./active-ticket-visibility";

function makeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { rpc };
}

describe("classifyActiveTicketVisibility", () => {
  it("returns active_ticket_visible whenever the embed already saw a ticket", () => {
    // The authoritative flag is irrelevant once the embed is visible —
    // it's never even consulted by resolveActiveTicketVisibility, but
    // the pure classifier must still be correct standalone either way.
    expect(classifyActiveTicketVisibility(true, true)).toBe("active_ticket_visible");
    expect(classifyActiveTicketVisibility(true, false)).toBe("active_ticket_visible");
  });

  it("returns active_ticket_hidden when the embed saw nothing but the RPC confirms one exists", () => {
    expect(classifyActiveTicketVisibility(false, true)).toBe("active_ticket_hidden");
  });

  it("returns no_active_ticket when neither the embed nor the RPC found one", () => {
    expect(classifyActiveTicketVisibility(false, false)).toBe("no_active_ticket");
  });
});

describe("resolveActiveTicketVisibility", () => {
  it("skips the RPC round-trip entirely when the embed already shows a visible ticket", async () => {
    const supabase = makeSupabase({ data: null, error: new Error("should never be called") });
    const result = await resolveActiveTicketVisibility(
      supabase as unknown as SupabaseClient,
      "c1",
      true,
    );
    expect(result).toBe("active_ticket_visible");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("calls conversation_has_active_ticket and returns active_ticket_hidden when it says true", async () => {
    const supabase = makeSupabase({ data: true, error: null });
    const result = await resolveActiveTicketVisibility(
      supabase as unknown as SupabaseClient,
      "c1",
      false,
    );
    expect(result).toBe("active_ticket_hidden");
    expect(supabase.rpc).toHaveBeenCalledWith("conversation_has_active_ticket", {
      p_conversation_id: "c1",
    });
  });

  it("calls conversation_has_active_ticket and returns no_active_ticket when it says false", async () => {
    const supabase = makeSupabase({ data: false, error: null });
    const result = await resolveActiveTicketVisibility(
      supabase as unknown as SupabaseClient,
      "c1",
      false,
    );
    expect(result).toBe("no_active_ticket");
  });

  it("fails closed (check_failed) rather than guessing 'no active ticket' when the RPC errors", async () => {
    const supabase = makeSupabase({ data: null, error: new Error("network error") });
    const result = await resolveActiveTicketVisibility(
      supabase as unknown as SupabaseClient,
      "c1",
      false,
    );
    expect(result).toBe("check_failed");
  });
});
