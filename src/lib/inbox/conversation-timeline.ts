import { format } from "date-fns";
import type { ConversationEvent, Message } from "@/types";

/**
 * Presentation-only merge of a conversation's messages and its
 * attendance-history events (migration 086, GET
 * /api/conversations/[id]/history). Events are NEVER messages: they are
 * never written to `messages`, never sent, never touch unread/last
 * message — they only become visual markers inside the chat timeline.
 */

export type TimelineItem =
  | { kind: "message"; key: string; at: string; message: Message }
  | {
      kind: "event";
      key: string;
      at: string;
      event: ConversationEvent;
      /** The event right before this one (chronologically), for context-dependent wording. */
      previousEvent: ConversationEvent | null;
    };

export interface TimelineDayGroup {
  /** Timestamp of the first item of the day (used for the date separator). */
  date: string;
  items: TimelineItem[];
}

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Ordering rule (deterministic, no timestamp shifting, no tolerance window):
 *   1. timestamp ASC (messages: created_at, events: created_at);
 *   2. on an EXACTLY equal timestamp, the event comes before the message;
 *   3. then id ASC within the same kind.
 */
export function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  const ta = toMillis(a.at);
  const tb = toMillis(b.at);
  if (ta !== tb) return ta - tb;
  if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
  const ida = a.kind === "message" ? a.message.id : a.event.id;
  const idb = b.kind === "message" ? b.message.id : b.event.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/** Interleaves messages and events. Never mutates the input arrays. */
export function buildConversationTimeline(
  messages: readonly Message[],
  events: readonly ConversationEvent[],
): TimelineItem[] {
  const orderedEvents = [...events].sort(
    (a, b) => toMillis(a.created_at) - toMillis(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const items: TimelineItem[] = [];
  for (const message of messages) {
    items.push({ kind: "message", key: `m:${message.id}`, at: message.created_at, message });
  }
  orderedEvents.forEach((event, i) => {
    items.push({
      kind: "event",
      key: `e:${event.id}`,
      at: event.created_at,
      event,
      previousEvent: i > 0 ? orderedEvents[i - 1] : null,
    });
  });
  return items.sort(compareTimelineItems);
}

/** Groups timeline items by local calendar day — a day with only events still gets its own group. */
export function groupTimelineByDate(items: readonly TimelineItem[]): TimelineDayGroup[] {
  const groups: TimelineDayGroup[] = [];
  let currentDay = "";
  for (const item of items) {
    const day = format(new Date(item.at), "yyyy-MM-dd");
    if (day !== currentDay) {
      currentDay = day;
      groups.push({ date: item.at, items: [item] });
    } else {
      groups[groups.length - 1].items.push(item);
    }
  }
  return groups;
}

// ------------------------------------------------------------
// Wording — returns translation keys (namespace Inbox.history) and
// values; the component resolves them with next-intl. Names come only
// from the snapshots stored on the event; nothing is invented.
// ------------------------------------------------------------

/** A name to show: the stored snapshot, or a generic fallback when the snapshot is NULL but the entity existed. */
export type EventNameRef = { kind: "name"; value: string } | { kind: "fallback"; fallback: "agent" | "queue" };

export interface EventDescription {
  key: string;
  values: Record<string, EventNameRef>;
  /** Extra discreet details (history_started only). */
  details: { key: string; values: Record<string, EventNameRef> }[];
}

function agentRef(id: string | null, name: string | null): EventNameRef | null {
  if (!id) return null;
  return name ? { kind: "name", value: name } : { kind: "fallback", fallback: "agent" };
}

function queueRef(id: string | null, name: string | null): EventNameRef | null {
  if (!id) return null;
  return name ? { kind: "name", value: name } : { kind: "fallback", fallback: "queue" };
}

function describe(key: string, values: Record<string, EventNameRef | null> = {}): EventDescription {
  const clean: Record<string, EventNameRef> = {};
  for (const [k, v] of Object.entries(values)) if (v) clean[k] = v;
  return { key, values: clean, details: [] };
}

export function describeConversationEvent(
  event: ConversationEvent,
  previousEvent: ConversationEvent | null = null,
): EventDescription {
  const actor = agentRef(event.actor_user_id, event.actor_name);
  const from = agentRef(event.from_agent_id, event.from_agent_name);
  const to = agentRef(event.to_agent_id, event.to_agent_name);
  const fromQueue = queueRef(event.from_queue_id, event.from_queue_name);
  const toQueue = queueRef(event.to_queue_id, event.to_queue_name);

  switch (event.event_type) {
    case "history_started": {
      const d = describe("historyStarted");
      if (to) d.details.push({ key: "historyStartedAgent", values: { agent: to } });
      if (toQueue) d.details.push({ key: "historyStartedQueue", values: { queue: toQueue } });
      return d;
    }
    case "opened":
      return describe("opened");
    case "reopened":
      return actor ? describe("reopenedBy", { actor }) : describe("reopenedByCustomer");
    case "assigned":
      if (!to) return describe("assignedUnknown");
      if (!actor) return describe("assignedSystem", { agent: to });
      if (event.actor_user_id === event.to_agent_id) return describe("assignedSelf", { agent: to });
      return describe("assignedBy", { actor, agent: to });
    case "reassigned": {
      if (!from || !to) return describe("assignedUnknown");
      const actorIsInvolved =
        event.actor_user_id === event.from_agent_id || event.actor_user_id === event.to_agent_id;
      return actor && !actorIsInvolved
        ? describe("reassignedBy", { from, to, actor })
        : describe("reassigned", { from, to });
    }
    case "unassigned":
      if (!from) return describe("unassignedUnknown");
      if (actor && event.actor_user_id !== event.from_agent_id) {
        return describe("unassignedBy", { actor, agent: from });
      }
      return describe("unassigned", { agent: from });
    case "queue_changed":
      if (fromQueue && toQueue) return describe("queueChanged", { from: fromQueue, to: toQueue });
      if (toQueue) return describe("queueAssigned", { to: toQueue });
      if (fromQueue) return describe("queueRemoved", { from: fromQueue });
      return describe("queueChangedUnknown");
    case "closed":
      return actor ? describe("closedBy", { actor }) : describe("closed");
    case "finalized": {
      const confirmsClose = event.from_status === "closed" && previousEvent?.event_type === "closed";
      if (confirmsClose) {
        return actor ? describe("finalizedConfirmedBy", { actor }) : describe("finalizedConfirmed");
      }
      return actor ? describe("finalizedBy", { actor }) : describe("finalized");
    }
    default:
      return describe("unknown");
  }
}

/** Every Inbox.history key the wording can produce (kept in sync with messages/*.json by the tests). */
export const CONVERSATION_HISTORY_MESSAGE_KEYS = [
  "historyStarted",
  "historyStartedAgent",
  "historyStartedQueue",
  "opened",
  "reopenedBy",
  "reopenedByCustomer",
  "assignedUnknown",
  "assignedSystem",
  "assignedSelf",
  "assignedBy",
  "reassigned",
  "reassignedBy",
  "unassigned",
  "unassignedBy",
  "unassignedUnknown",
  "queueChanged",
  "queueAssigned",
  "queueRemoved",
  "queueChangedUnknown",
  "closed",
  "closedBy",
  "finalized",
  "finalizedBy",
  "finalizedConfirmed",
  "finalizedConfirmedBy",
  "unknown",
  "fallbackAgent",
  "fallbackQueue",
] as const;
