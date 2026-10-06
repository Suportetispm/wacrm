"use client";

import { format } from "date-fns";
import { useTranslations } from "next-intl";
import type { ConversationEvent } from "@/types";
import {
  describeConversationEvent,
  type EventNameRef,
} from "@/lib/inbox/conversation-timeline";

/**
 * Attendance-history marker inside the chat timeline (migration 086).
 * Presentation only: no bubble, no avatar, no action — a thin centered
 * separator with the event text and its time. It is NOT a message and
 * is never sent anywhere. `history_started` is rendered even more
 * discreetly: it only marks where recorded history begins.
 */
export function ConversationEventMarker({
  event,
  previousEvent,
}: {
  event: ConversationEvent;
  previousEvent: ConversationEvent | null;
}) {
  const t = useTranslations("Inbox.history");
  const description = describeConversationEvent(event, previousEvent);

  const resolve = (values: Record<string, EventNameRef>) => {
    const out: Record<string, string> = {};
    for (const [k, ref] of Object.entries(values)) {
      out[k] =
        ref.kind === "name"
          ? ref.value
          : t(ref.fallback === "agent" ? "fallbackAgent" : "fallbackQueue");
    }
    return out;
  };

  const text = [
    t(description.key, resolve(description.values)),
    ...description.details.map((d) => t(d.key, resolve(d.values))),
  ].join(" · ");
  const time = format(new Date(event.created_at), "HH:mm");
  const isHistoryStart = event.event_type === "history_started";

  return (
    <div
      role="separator"
      aria-label={`${text} · ${time}`}
      data-slot="conversation-event-marker"
      data-event-type={event.event_type}
      className={
        isHistoryStart
          ? "my-2 flex items-center gap-2 opacity-70"
          : "my-2 flex items-center gap-2"
      }
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span
        className={
          isHistoryStart
            ? "max-w-[80%] text-center text-[10px] italic text-muted-foreground"
            : "max-w-[80%] text-center text-[10px] font-medium text-muted-foreground"
        }
      >
        {text} • {time}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
