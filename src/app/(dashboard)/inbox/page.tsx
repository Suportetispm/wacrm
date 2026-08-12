"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  moveConversationToTop,
  normalizeConversation,
  reconcileLoadedConversations,
  shouldRollbackConversationPreview,
  updateConversationPreview,
} from "@/lib/inbox/conversations";
import { isOpenTransitionEligible } from "@/lib/inbox/auto-status";
import { openPendingConversation, sweepStaleConversations } from "@/lib/inbox/status-automation";
import type { Conversation, Message, Contact, ConversationStatus } from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { NewConversationModal } from "@/components/inbox/new-conversation-modal";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** How often the light background sweep for the 10-minute pending
 *  reversion runs, independent of resyncToken (which also drives a
 *  full conversations/messages refetch — this must NOT piggyback on
 *  that, or the "no aggressive polling / no full Inbox refetch" rule
 *  would be violated). Midpoint of the agreed 90-120s window. */
const STALE_SWEEP_INTERVAL_MS = 100_000;

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, accountRole } = useAuth();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  const [activeProvider, setActiveProvider] = useState<"meta" | "uazapi" | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", convId)
        .maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) return;
      const fetched = normalizeConversation(data);
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? { ...c, contact: c.contact ?? fetched.contact }
              : c,
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;

      if (!user) return;

      // whatsapp_config is one-row-per-account post-multi-user, so
      // the previous `.eq('user_id', user.id)` would miss the row
      // for any teammate who didn't personally save the config —
      // the "WhatsApp not connected" banner would show in the
      // shared inbox even though the admin had it configured.
      // Resolve account_id via the profile and query by that.
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("status, provider")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
      setActiveProvider((data?.provider as "meta" | "uazapi" | undefined) ?? null);
    };

    checkConnection();
  }, []);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        // Add to messages if it belongs to active conversation
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Replace optimistic message if it exists
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("temp-")
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Update conversation list preview and bump it to the top — a new
        // message is always the most recent activity, whether it's the
        // customer's inbound text or the realtime echo of our own
        // outbound send confirming the optimistic bump from
        // handleConversationActivity below. moveConversationToTop no-ops
        // if it's already first, so this is safe to call unconditionally.
        //
        // We need to know *synchronously* whether the conv is already in
        // state to decide between patching the preview and triggering a
        // hydrate — see the comment on knownConvIdsRef for why a closure
        // flag inside the updater would always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) => {
            const current = prev.find(
              (c) => c.id === newMsg.conversation_id,
            );
            const patched = updateConversationPreview(
              prev,
              newMsg.conversation_id,
              {
                last_message_text: newMsg.content_text ?? "",
                last_message_at: newMsg.created_at,
                unread_count:
                  activeConversation?.id === newMsg.conversation_id
                    ? 0
                    : (current?.unread_count ?? 0) + 1,
              },
            );
            return moveConversationToTop(patched, newMsg.conversation_id);
          });
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        // Update message status
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conv.id)) {
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          setConversations((prev) => {
            // Only bump position when this UPDATE reflects real new
            // activity (last_message_at actually changed from what we
            // already had) — a status flip or an assignment change also
            // fires a conversations UPDATE, and those must NOT jump the
            // conversation to the top. Compared against our own prior
            // state rather than the realtime payload's `old`: the
            // `conversations` table isn't REPLICA IDENTITY FULL, so
            // Postgres only ever sends the primary key in `old` — its
            // `last_message_at` is always undefined and can't be used
            // for this comparison. This is a defensive secondary path:
            // the message INSERT handler above already reorders for the
            // common case, but a missed/out-of-order INSERT event
            // shouldn't leave the list stuck stale.
            const current = prev.find((c) => c.id === conv.id);
            const activityChanged =
              !!conv.last_message_at &&
              current?.last_message_at !== conv.last_message_at;
            const merged = prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    ...conv,
                    unread_count: isActive ? 0 : conv.unread_count,
                  }
                : c,
            );
            return activityChanged
              ? moveConversationToTop(merged, conv.id)
              : merged;
          });
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) =>
            prev ? { ...prev, ...conv } : prev
          );
        }
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * 10-minute pending-reversion sweep — fires opportunistically on the
   * exact same events that already trigger a resync (mount, WS
   * reconnect, tab visibility regain, manual refresh button), plus a
   * light interval below for the case where the Inbox sits open and
   * idle without any of those. Deliberately does NOT read `resyncToken`
   * changes as "refetch the list" — this only ever calls
   * sweepStaleConversations, a single lightweight query + guarded
   * per-row updates, never the full conversations/messages refetch
   * resyncToken itself drives elsewhere. Any row it actually reverts
   * arrives back into `conversations` state through the existing
   * Realtime `conversations` UPDATE handler, not through a local patch
   * here — status-only changes there already skip reordering (Parte 9).
   *
   * Skipped for `viewer` role (RLS would filter its writes to 0 rows
   * anyway — a real member of the account, just least-privileged) and
   * while the role hasn't resolved yet.
   */
  useEffect(() => {
    if (accountRole !== "agent" && accountRole !== "admin" && accountRole !== "owner") return;
    const supabase = createClient();
    sweepStaleConversations(supabase).catch((error) => {
      console.error("Stale-conversation sweep failed:", error);
    });
  }, [resyncToken, accountRole]);

  useEffect(() => {
    if (accountRole !== "agent" && accountRole !== "admin" && accountRole !== "owner") return;
    const interval = setInterval(() => {
      const supabase = createClient();
      sweepStaleConversations(supabase).catch((error) => {
        console.error("Stale-conversation sweep failed:", error);
      });
    }, STALE_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [accountRole]);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  /**
   * Fires whenever an agent OPENS a 'pending' conversation — from the
   * list click (handleSelectConversation) or the deep-link auto-select
   * in handleConversationsLoaded below, the two places a conversation
   * becomes "active". Optimistically applies the pending → in_progress
   * (+ claim-if-unassigned) transition locally, then confirms/corrects
   * against the DB via the guarded RPC-backed writes in
   * status-automation.ts. isOpenTransitionEligible already filters out
   * admin/owner callers and non-pending conversations, so this is a
   * no-op call for every other case — safe to call unconditionally
   * from both entry points without a separate guard at each call site.
   */
  const handleOpenPendingConversation = useCallback(
    (conv: Conversation) => {
      if (!user?.id || !isOpenTransitionEligible(conv, accountRole)) return;

      const before = {
        status: conv.status,
        assigned_agent_id: conv.assigned_agent_id,
      };
      const optimisticAssignee = conv.assigned_agent_id ?? user.id;
      const patch = {
        status: "in_progress" as ConversationStatus,
        assigned_agent_id: optimisticAssignee,
      };

      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, ...patch } : c)),
      );
      setActiveConversation((prev) =>
        prev && prev.id === conv.id ? { ...prev, ...patch } : prev,
      );

      const supabase = createClient();
      openPendingConversation(supabase, conv, user.id)
        .then((result) => {
          if (result.outcome === "claimed" || result.outcome === "resumed") {
            return; // optimistic guess confirmed, nothing to reconcile
          }
          if (result.outcome === "error") {
            console.error("Failed to open pending conversation:", result.error);
          }
          // "not_applicable" (assigned to someone else, raced, ticketed,
          // or no longer pending) or "error" — revert to what it was
          // before; a genuine winning change elsewhere still arrives
          // via the existing Realtime subscription.
          setConversations((prev) =>
            prev.map((c) => (c.id === conv.id ? { ...c, ...before } : c)),
          );
          setActiveConversation((prevActive) =>
            prevActive && prevActive.id === conv.id
              ? { ...prevActive, ...before }
              : prevActive,
          );
        })
        .catch((error) => {
          console.error("Failed to open pending conversation:", error);
          setConversations((prev) =>
            prev.map((c) => (c.id === conv.id ? { ...c, ...before } : c)),
          );
          setActiveConversation((prevActive) =>
            prevActive && prevActive.id === conv.id
              ? { ...prevActive, ...before }
              : prevActive,
          );
        });
    },
    [user?.id, accountRole],
  );

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      // FASE 5A root cause: unlike handleConversationEvent's realtime
      // UPDATE branch (which forces unread_count: 0 for whichever
      // conversation is active), this resync path used to do a blind
      // `setConversations(loaded)` — a raw DB snapshot that can still
      // carry the pre-reset unread_count if this fetch lands inside the
      // window between opening a conversation and the server-side
      // mark_conversation_read call actually landing. reconcileLoadedConversations
      // applies the exact same isActive suppression here, so a resync
      // (tab visibility regain, WS reconnect, manual refresh) can no
      // longer reintroduce a stale badge for the conversation the user
      // already has open. See its doc comment for why this never hides
      // a genuinely new message.
      setConversations(
        reconcileLoadedConversations(loaded, activeConversation?.id),
      );
      // Resolve a pending deep-link here rather than in an effect — this
      // is an event handler, so the setState calls below are allowed by
      // react-hooks/set-state-in-effect. Runs once per ?c=<id> URL value
      // via the ref, so realtime refreshes of the list can't snap the
      // user back to the deep-linked thread after they've navigated.
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        // If the deep-linked conversation is already the active one
        // (e.g. because the user clicked it in the list and we
        // router.replace()'d the URL, which made the ConversationList
        // refetch and land us back here), do NOT re-apply it. Doing so
        // would setMessages([]) on a thread whose messages have
        // already been loaded by MessageThread — and because
        // conversationId didn't change, MessageThread wouldn't
        // refetch. The thread would read "No messages yet" until a
        // full page reload rehydrated state from scratch.
        if (activeConversation?.id === deepLinkConvId) return;
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);
          // Mirror the optimistic unread reset that handleSelectConversation
          // does — the user just deep-linked into this conv, treat that the
          // same as a click. Leaves activeConversation.unread_count alone so
          // the MessageThread reset effect still fires the server UPDATE.
          if (match.unread_count > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === match.id ? { ...c, unread_count: 0 } : c,
              ),
            );
          }
          handleOpenPendingConversation(match);
        }
      }
    },
    [deepLinkConvId, activeConversation?.id, handleOpenPendingConversation]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // messages array, but the fetch effect in MessageThread only re-runs
      // when conversationId changes — so messages would stay empty until
      // the user navigated away and back. Bail out early instead.
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      // Optimistically clear the unread badge for this conv. The
      // server-side reset is fired by the unread-reset effect inside
      // MessageThread (which reads activeConversation.unread_count, not
      // the list copy — so we deliberately leave that intact below to
      // keep the effect firing), and the realtime UPDATE that comes
      // back will sync to 0 again as a no-op. Zeroing the list copy
      // here means the user sees the badge disappear the instant they
      // click instead of waiting for the round-trip — and it persists
      // even if the realtime UPDATE is dropped.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0
            ? { ...c, unread_count: 0 }
            : c,
        ),
      );
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      router.replace(`/inbox?c=${conv.id}`, { scroll: false });
      handleOpenPendingConversation(conv);
    },
    [activeConversation?.id, router, handleOpenPendingConversation]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/inbox", { scroll: false });
  }, [router]);

  // Fired by NewConversationModal after it finds-or-creates a
  // conversation. Prepends it in case the realtime INSERT hasn't
  // landed yet, then reuses the existing select-and-navigate logic —
  // no new selection code path.
  const handleConversationCreated = useCallback(
    (conv: Conversation) => {
      setConversations((prev) =>
        prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev],
      );
      handleSelectConversation(conv);
    },
    [handleSelectConversation],
  );

  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  /**
   * Optimistic list bump fired the instant the agent hits Send (before
   * the UAZAPI/Meta round-trip and the realtime confirmation that
   * follows it) — moves the conversation to the top and updates its
   * preview/timestamp immediately. handleMessageEvent and
   * handleConversationEvent above converge on the exact same fields
   * once the real event lands (via the same two helpers), so this is
   * just a head start, not a second source of truth — the confirmation
   * simply re-applies the (by then identical) values and no-ops the
   * reorder since the conversation is already first.
   */
  const handleConversationActivity = useCallback(
    (conversationId: string, previewText: string, at: string) => {
      setConversations((prev) =>
        moveConversationToTop(
          updateConversationPreview(prev, conversationId, {
            last_message_text: previewText,
            last_message_at: at,
          }),
          conversationId,
        ),
      );
    },
    [],
  );

  /**
   * Reverts the preview fields set by handleConversationActivity when
   * the send that triggered it turns out to have failed — otherwise a
   * failed message would permanently leave the list showing its text/
   * time as if it had gone through. Guarded on `optimisticAt` still
   * being the conversation's current last_message_at: if genuine new
   * activity (another message, inbound or outbound) landed for this
   * conversation in the meantime, that must win instead of being
   * clobbered by this rollback.
   *
   * Deliberately does NOT move the conversation back down — by the time
   * a send fails, unrelated activity may have reordered the list
   * further, and reconstructing "where it used to be" isn't worth the
   * complexity for what's a rare, self-correcting (the next real
   * activity fixes position anyway) edge case.
   */
  const handleConversationActivityRollback = useCallback(
    (
      conversationId: string,
      optimisticAt: string,
      previous: { last_message_text?: string; last_message_at?: string },
    ) => {
      setConversations((prev) =>
        shouldRollbackConversationPreview(prev, conversationId, optimisticAt)
          ? updateConversationPreview(prev, conversationId, previous)
          : prev,
      );
    },
    [],
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
    },
    [activeConversation]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">
            {t("whatsappNotConnected")}
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            onOpenNewConversation={() => setNewConversationOpen(true)}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            provider={activeProvider}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onOptimisticActivity={handleConversationActivity}
            onOptimisticActivityRollback={handleConversationActivityRollback}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar contact={activeContact} />
          </div>
        )}
      </div>

      <NewConversationModal
        open={newConversationOpen}
        onOpenChange={setNewConversationOpen}
        onCreated={handleConversationCreated}
      />
    </div>
  );
}
