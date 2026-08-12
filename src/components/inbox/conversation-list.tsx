"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  countConversationsByStatus,
  matchesContactFilters,
  matchesInboxFilters,
  normalizeConversations,
  sortConversationsByRecentActivity,
  type InboxFilters,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Profile, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  Plus,
  AlertCircle,
  Clock,
  MessageCircle,
  Hourglass,
  CheckCircle2,
  CheckCheck,
  UserX,
  Users,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Opens the "New conversation" modal — owned/rendered by the page. */
  onOpenNewConversation: () => void;
}

// Migration 045 (FASE 5C): ícone + cor por status, para o badge nunca
// depender só de cor (acessibilidade — item explícito do pedido).
// `labelKey` aponta para uma chave própria deste namespace
// (Inbox.conversationList), separada das chaves usadas pelo dropdown
// de status em message-thread.tsx (Inbox.messageThread) — os dois
// componentes usam namespaces de tradução diferentes e não podem
// compartilhar chave.
const STATUS_BADGE_CONFIG: Record<
  ConversationStatus,
  { icon: typeof Clock; className: string; labelKey: string }
> = {
  pending: { icon: Clock, className: "text-amber-400 bg-amber-400/10", labelKey: "statusPending" },
  in_progress: { icon: MessageCircle, className: "text-primary bg-primary/10", labelKey: "statusInProgress" },
  waiting_customer: { icon: Hourglass, className: "text-blue-400 bg-blue-400/10", labelKey: "statusWaitingCustomer" },
  closed: { icon: CheckCircle2, className: "text-muted-foreground bg-muted", labelKey: "statusClosed" },
  finalized: { icon: CheckCheck, className: "text-emerald-500 bg-emerald-500/10", labelKey: "statusFinalized" },
};

/** As quatro abas primárias — 'closed' fica de fora de propósito, acessível só pelo botão secundário "Encerradas". */
const PRIMARY_TABS = ["in_progress", "waiting_customer", "pending", "finalized"] as const;

// 'in_progress' e 'pending' reaproveitam as chaves de status/filtro já
// existentes (o texto da aba é idêntico ao do badge/filtro nesses dois
// casos); só 'waiting_customer' e 'finalized' precisam de uma forma
// mais curta/plural própria para caber na aba.
const TAB_LABEL_KEYS: Record<(typeof PRIMARY_TABS)[number], string> = {
  in_progress: "statusInProgress",
  waiting_customer: "tabWaitingCustomer",
  pending: "filterPending",
  finalized: "tabFinalized",
};

type StatusFilter = ConversationStatus | "all";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onOpenNewConversation,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  // Same capability the composer already gates on — viewers browse
  // read-only, so they shouldn't see a button that would just fail
  // the RLS insert.
  const canSend = useCan("send-messages");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string | "unassigned" | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Teammates for the "responsável" filter — same self-contained fetch
  // pattern as message-thread.tsx's own profiles list (RLS already
  // bounds this to the caller's account).
  const [profiles, setProfiles] = useState<Profile[]>([]);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoadError(false);
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoadError(true);
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("profiles").select("*").order("full_name");
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch profiles:", error);
        return;
      }
      setProfiles((data as Profile[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const profilesByUserId = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const p of profiles) m.set(p.user_id, p);
    return m;
  }, [profiles]);

  // Contagem por status entre TODAS as conversas carregadas (não
  // reduzida por busca/etiquetas/empresa/responsável/não-lidas) — as
  // abas mostram "quantas existem", não "quantas sobram depois dos
  // outros filtros". Ver countConversationsByStatus.
  const statusCounts = useMemo(() => countConversationsByStatus(conversations), [conversations]);

  const inboxFilters: InboxFilters = useMemo(
    () => ({ status: statusFilter, unreadOnly, assigneeId: assigneeFilter }),
    [statusFilter, unreadOnly, assigneeFilter],
  );

  const filtered = useMemo(() => {
    let result = conversations.filter((c) => matchesInboxFilters(c, inboxFilters));

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    // Render-time ordering guarantee — see sortConversationsByRecentActivity's
    // doc comment for why this isn't redundant with moveConversationToTop.
    return sortConversationsByRecentActivity(result);
  }, [conversations, inboxFilters, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const hasExtraFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    unreadOnly ||
    assigneeFilter !== null ||
    statusFilter === "closed";

  const clearAllFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setUnreadOnly(false);
    setAssigneeFilter(null);
    setStatusFilter("all");
  }, []);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const assigneeChipLabel =
    assigneeFilter === "unassigned"
      ? t("unassigned")
      : assigneeFilter
        ? (profilesByUserId.get(assigneeFilter)?.full_name ?? t("assignee"))
        : null;

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        {canSend && (
          <Button
            onClick={onOpenNewConversation}
            size="sm"
            className="w-full justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Nova conversa
          </Button>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        {/* Abas de status (FASE 5C) — "Todas" + as quatro abas
            primárias pedidas. 'closed' fica fora das abas de propósito;
            é alcançável só pelo botão "Encerradas" logo abaixo. */}
        <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label={t("statusTabsLabel")}>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
            className={cn(
              "shrink-0 rounded-md px-2 py-1 text-xs font-medium",
              statusFilter === "all"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t("filterAll")}
          </button>
          {PRIMARY_TABS.map((status) => (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={statusFilter === status}
              onClick={() => setStatusFilter(status)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                statusFilter === status
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(TAB_LABEL_KEYS[status])}
              {statusCounts[status] > 0 && (
                <span className="rounded-full bg-muted px-1 text-[10px] tabular-nums">
                  {statusCounts[status]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {/* Status "Encerradas" — secundário de propósito (fora das
              abas), conforme pedido. */}
          <button
            type="button"
            onClick={() => setStatusFilter(statusFilter === "closed" ? "all" : "closed")}
            className={cn(
              "inline-flex items-center gap-1 h-7 px-2 text-xs rounded-md hover:bg-muted",
              statusFilter === "closed" ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CheckCircle2 className="h-3 w-3" />
            {t("filterClosed")}
            {statusCounts.closed > 0 && (
              <span className="rounded-full bg-muted px-1 text-[10px] tabular-nums">
                {statusCounts.closed}
              </span>
            )}
          </button>

          <DropdownMenuCheckboxItemButton
            checked={unreadOnly}
            onCheckedChange={setUnreadOnly}
            label={t("filterUnread")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                assigneeFilter ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Users className="h-3 w-3" />
              {t("assignee")}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
              <DropdownMenuItem
                onClick={() => setAssigneeFilter(null)}
                className={cn("text-sm", assigneeFilter === null ? "text-primary" : "text-popover-foreground")}
              >
                {t("allAssignees")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setAssigneeFilter("unassigned")}
                className={cn(
                  "flex items-center gap-2 text-sm",
                  assigneeFilter === "unassigned" ? "text-primary" : "text-popover-foreground",
                )}
              >
                <UserX className="h-3.5 w-3.5" />
                {t("unassigned")}
              </DropdownMenuItem>
              {profiles.length > 0 && <DropdownMenuSeparator />}
              {profiles.map((p) => (
                <DropdownMenuItem
                  key={p.user_id}
                  onClick={() => setAssigneeFilter(p.user_id)}
                  className={cn(
                    "text-sm",
                    assigneeFilter === p.user_id ? "text-primary" : "text-popover-foreground",
                  )}
                >
                  <span className="truncate">{p.full_name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasExtraFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {unreadOnly && (
              <button
                onClick={() => setUnreadOnly(false)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{t("filterUnread")}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {assigneeChipLabel && (
              <button
                onClick={() => setAssigneeFilter(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{assigneeChipLabel}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {statusFilter === "closed" && (
              <button
                onClick={() => setStatusFilter("all")}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{t("filterClosed")}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearAllFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-muted-foreground">{t("loadError")}</p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noMatchingConversations")}</p>
            <button
              onClick={clearAllFilters}
              className="mt-2 text-xs text-primary hover:underline"
            >
              {t("clearAll")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** Simple checkbox-shaped toggle button — used for "Não lidas", which doesn't need a dropdown of its own. */
function DropdownMenuCheckboxItemButton({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
        checked ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  const statusConfig = STATUS_BADGE_CONFIG[conversation.status];
  const StatusIcon = statusConfig.icon;
  const statusLabel = t(statusConfig.labelKey);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Badge de não lida — SEMPRE separado do badge de status
                abaixo: numérico, só aparece com unread_count > 0, e
                nunca influencia (nem é influenciado por) o status. */}
            {conversation.unread_count > 0 && (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
                role="status"
                aria-label={t("unreadCount", { count: conversation.unread_count })}
              >
                {conversation.unread_count}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
          </div>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* Badge textual de status — ícone + cor + texto (nunca só
              cor), sempre visível independente de unread_count. Largura
              máxima com truncamento evita que "Aguardando cliente"
              quebre o layout compacto da lista; título/aria-label
              carregam o texto completo. */}
          <span
            className={cn(
              "flex max-w-[7.5rem] shrink items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              statusConfig.className,
            )}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          >
            <StatusIcon className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{statusLabel}</span>
          </span>
        </div>
      </div>
    </button>
  );
}
