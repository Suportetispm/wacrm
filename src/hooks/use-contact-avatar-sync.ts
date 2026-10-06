"use client";

import { useEffect, useRef } from "react";
import type { Conversation } from "@/types";
import {
  createAvatarSyncQueue,
  type AvatarSyncQueue,
  type AvatarSyncSender,
} from "@/lib/inbox/avatar-sync-queue";
import type { AvatarSyncResponse, AvatarSyncResult } from "@/lib/inbox/contact-avatar-sync-shared";

const sendAvatarSync: AvatarSyncSender = async (conversationIds) => {
  const res = await fetch("/api/contacts/avatar-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationIds }),
  });
  if (res.status === 429) return { ok: false, throttled: true };
  if (!res.ok) return { ok: false, throttled: false };
  return { ok: true, response: (await res.json()) as AvatarSyncResponse };
};

/**
 * Background WhatsApp-avatar sync for the conversations loaded in the
 * Inbox. Never blocks rendering; one queue per page mount (see
 * avatar-sync-queue.ts for dedup / single-flight / stop rules).
 */
export function useContactAvatarSync(
  conversations: Conversation[],
  onResults: (results: AvatarSyncResult[]) => void,
): void {
  const onResultsRef = useRef(onResults);
  useEffect(() => {
    onResultsRef.current = onResults;
  });

  const queueRef = useRef<AvatarSyncQueue | null>(null);
  useEffect(() => {
    const queue = createAvatarSyncQueue({
      send: sendAvatarSync,
      onResults: (results) => onResultsRef.current(results),
    });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    queueRef.current?.enqueue(conversations);
  }, [conversations]);
}
