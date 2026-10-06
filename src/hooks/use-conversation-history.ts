"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationEvent } from "@/types";

/**
 * Attendance-history events of the open conversation, from
 * GET /api/conversations/[id]/history (the only source — never a direct
 * conversation_events query, never service-role, no account_id sent).
 *
 * No polling and no extra realtime channel. The caller passes what
 * already reaches the thread:
 *   - `refreshKey`: resyncToken + status / assigned_agent_id / queue_id;
 *   - `updatedAt`: conversations.updated_at — it only changes when a row
 *     confirmed by the database arrives (realtime / refetch); local
 *     optimistic patches never touch it;
 *   - `paused`: a local optimistic status change still in flight.
 *
 * A fetch done for a key that may still be optimistic (conversation just
 * opened, or a local change without a server row) is "unconfirmed": the
 * next server row refetches once more. This makes the Inbox auto-claim
 * (optimistic in_progress + assignee applied by the page before its
 * commit) deterministic: the claim's own realtime row always triggers a
 * fetch after the commit. Once confirmed, server rows that leave the key
 * unchanged (messages, read state) fetch nothing.
 */

export type HistoryFetchResult = { ok: true; events: ConversationEvent[] } | { ok: false };
export type HistoryFetcher = (conversationId: string) => Promise<HistoryFetchResult>;

export const fetchConversationHistory: HistoryFetcher = async (conversationId) => {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/history`, {
      cache: "no-store",
    });
    // Not visible / not found: show the chat without markers.
    if (res.status === 404) return { ok: true, events: [] };
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { events?: ConversationEvent[] };
    return { ok: true, events: Array.isArray(body.events) ? body.events : [] };
  } catch {
    return { ok: false };
  }
};

export interface HistorySyncInput {
  conversationId: string | null | undefined;
  refreshKey: string;
  /** conversations.updated_at as last received from the database. */
  updatedAt: string | null | undefined;
  paused: boolean;
}

export interface ConversationHistoryState {
  conversationId: string | null;
  events: ConversationEvent[];
}

/**
 * Framework-free core of the hook (unit-testable without a DOM).
 *
 * Fetch decision on every sync (no timers):
 *   - conversation changed → fetch now, UNCONFIRMED (its key may be an
 *     optimistic patch applied together with the selection);
 *   - paused → nothing (the optimistic value is not committed yet);
 *   - pause just lifted (local write finished) → fetch, CONFIRMED, if the
 *     key differs from the last fetch; a rollback restored the old key →
 *     nothing;
 *   - a new server row (updatedAt changed) → fetch, CONFIRMED, if the key
 *     differs from the last fetch OR the last fetch was unconfirmed;
 *   - otherwise a key change without a server row (resync, local change
 *     made after its commit) → fetch, UNCONFIRMED.
 * Every response REPLACES the list; a response that is not the latest
 * request, or is for a conversation no longer open, is discarded; a
 * failed fetch publishes nothing and lets the next sync retry.
 */
export function createConversationHistoryController(opts: {
  fetchHistory: HistoryFetcher;
  onState: (state: ConversationHistoryState) => void;
}) {
  let currentConversationId: string | null = null;
  let fetchedKey: string | null = null;
  let fetchedConfirmed = false;
  let lastUpdatedAt: string | null = null;
  let lastPaused = false;
  let seq = 0;

  async function load(conversationId: string, key: string, confirmed: boolean): Promise<void> {
    fetchedKey = key;
    fetchedConfirmed = confirmed;
    const mySeq = ++seq;
    const result = await opts.fetchHistory(conversationId);
    if (mySeq !== seq || currentConversationId !== conversationId) return;
    if (!result.ok) {
      // Let the next sync retry.
      if (fetchedKey === key) fetchedKey = null;
      return;
    }
    opts.onState({ conversationId, events: result.events });
  }

  return {
    async sync(input: HistorySyncInput): Promise<void> {
      const conversationId = input.conversationId ?? null;
      const updatedAt = input.updatedAt ?? null;
      const key = input.refreshKey;

      if (conversationId !== currentConversationId) {
        currentConversationId = conversationId;
        fetchedKey = null;
        fetchedConfirmed = false;
        lastUpdatedAt = updatedAt;
        lastPaused = input.paused;
        seq++; // discard anything still in flight for the previous conversation
        if (!conversationId || input.paused) return;
        return load(conversationId, key, false);
      }
      if (!conversationId) return;

      const serverRowArrived = updatedAt !== lastUpdatedAt;
      lastUpdatedAt = updatedAt;
      const pauseLifted = lastPaused && !input.paused;
      lastPaused = input.paused;

      if (input.paused) return;
      if (pauseLifted) {
        if (key !== fetchedKey) return load(conversationId, key, true);
        return;
      }
      if (serverRowArrived) {
        if (key !== fetchedKey || !fetchedConfirmed) return load(conversationId, key, true);
        return;
      }
      if (key !== fetchedKey) return load(conversationId, key, false);
    },
  };
}

export function useConversationHistory(input: HistorySyncInput): ConversationEvent[] {
  const [state, setState] = useState<ConversationHistoryState>({ conversationId: null, events: [] });
  const controllerRef = useRef<ReturnType<typeof createConversationHistoryController> | null>(null);

  const { conversationId, refreshKey, updatedAt, paused } = input;
  useEffect(() => {
    if (!controllerRef.current) {
      controllerRef.current = createConversationHistoryController({
        fetchHistory: fetchConversationHistory,
        onState: setState,
      });
    }
    void controllerRef.current.sync({ conversationId, refreshKey, updatedAt, paused });
  }, [conversationId, refreshKey, updatedAt, paused]);

  // Events of another conversation are never shown while the new one loads.
  return conversationId && state.conversationId === conversationId ? state.events : EMPTY;
}

const EMPTY: ConversationEvent[] = [];
