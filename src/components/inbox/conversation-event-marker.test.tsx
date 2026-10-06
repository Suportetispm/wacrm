import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { format } from "date-fns";

// Same approach as message-bubble.test.tsx: no DOM in this Vitest setup;
// next-intl is replaced by a translator that echoes key + values so the
// markup shows exactly which wording/snapshots were used.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length ? `${key}(${Object.values(vars).join(",")})` : key,
}));

import { ConversationEventMarker } from "./conversation-event-marker";
import type { ConversationEvent } from "@/types";

const AT = "2026-10-06T09:11:00.000Z";

function event(extra: Partial<ConversationEvent>): ConversationEvent {
  return {
    id: "e1",
    event_type: "assigned",
    actor_user_id: null,
    actor_name: null,
    from_agent_id: null,
    from_agent_name: null,
    to_agent_id: "u-1",
    to_agent_name: "Maria",
    from_queue_id: null,
    from_queue_name: null,
    to_queue_id: null,
    to_queue_name: null,
    from_status: "pending",
    to_status: "pending",
    created_at: AT,
    ...extra,
  };
}

function render(e: ConversationEvent, previousEvent: ConversationEvent | null = null) {
  return renderToStaticMarkup(React.createElement(ConversationEventMarker, { event: e, previousEvent }));
}

describe("ConversationEventMarker", () => {
  it("renders the event text from the stored snapshot and the HH:mm time", () => {
    const html = render(event({}));
    expect(html).toContain("assignedSystem(Maria)");
    expect(html).toContain(format(new Date(AT), "HH:mm"));
  });

  it("is a separator, not a message bubble: no button, no link, no avatar, no message markup", () => {
    const html = render(event({}));
    expect(html).toContain('role="separator"');
    expect(html).toContain('data-slot="conversation-event-marker"');
    expect(html).not.toMatch(/<button|<a |<img|onClick|rounded-2xl|rounded-lg/);
  });

  it("history_started is rendered more discreetly (italic, dimmed) and never says 'started'", () => {
    const hs = render(event({ event_type: "history_started", to_status: "in_progress", from_status: null }));
    const normal = render(event({}));
    expect(hs).toContain('data-event-type="history_started"');
    expect(hs).toContain("italic");
    expect(hs).toContain("opacity-70");
    expect(normal).not.toContain("italic");
    expect(hs).toContain("historyStarted");
  });

  it("uses the generic fallback for a NULL name and never writes 'by' without an actor", () => {
    expect(render(event({ to_agent_name: null }))).toContain("assignedSystem(fallbackAgent)");
    const closed = render(event({ event_type: "closed", from_status: "in_progress", to_status: "closed", to_agent_id: null, to_agent_name: null }));
    expect(closed).toContain(">closed •");
    expect(closed).not.toContain("closedBy");
  });

  it("closed followed by finalized reads as a confirmation", () => {
    const prev = event({ id: "c", event_type: "closed", from_status: "in_progress", to_status: "closed" });
    const html = render(event({ id: "f", event_type: "finalized", from_status: "closed", to_status: "finalized" }), prev);
    expect(html).toContain("finalizedConfirmed");
  });
});
