import { describe, expect, it, vi } from "vitest";
import { markConversationRead } from "./mark-read";

function fakeSupabase(response: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(response) };
}

describe("markConversationRead", () => {
  it("calls the mark_conversation_read RPC with the conversation id", async () => {
    const supabase = fakeSupabase({ data: "marked_read", error: null });

    await markConversationRead(supabase as never, "conv-1");

    expect(supabase.rpc).toHaveBeenCalledWith("mark_conversation_read", {
      p_conversation_id: "conv-1",
    });
  });

  it("returns outcome 'marked_read' when the RPC reports a real reset", async () => {
    const supabase = fakeSupabase({ data: "marked_read", error: null });

    const result = await markConversationRead(supabase as never, "conv-1");

    expect(result).toEqual({ outcome: "marked_read" });
  });

  it("returns outcome 'already_read' when the RPC reports unread_count was already 0", async () => {
    const supabase = fakeSupabase({ data: "already_read", error: null });

    const result = await markConversationRead(supabase as never, "conv-1");

    expect(result).toEqual({ outcome: "already_read" });
  });

  it("returns outcome 'error' without throwing when the RPC errors (auth/tenancy/not-found)", async () => {
    const rpcError = { message: "mark_conversation_read: conversation not found" };
    const supabase = fakeSupabase({ data: null, error: rpcError });

    const result = await markConversationRead(supabase as never, "conv-1");

    expect(result).toEqual({ outcome: "error", error: rpcError });
  });
});
