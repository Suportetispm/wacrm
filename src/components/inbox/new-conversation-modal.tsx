"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { Loader2, Search, UserPlus, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { normalizePhone, isValidE164 } from "@/lib/whatsapp/phone-utils";
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from "@/lib/contacts/dedupe";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
  findOrCreateConversationForContact,
} from "@/lib/inbox/conversations";
import type { Conversation, Contact } from "@/types";

interface NewConversationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (conversation: Conversation) => void;
}

type Mode = "existing" | "new";

export function NewConversationModal({
  open,
  onOpenChange,
  onCreated,
}: NewConversationModalProps) {
  const supabase = createClient();
  const { accountId, user } = useAuth();

  const [mode, setMode] = useState<Mode>("existing");
  const [submitting, setSubmitting] = useState(false);

  // Existing-contact search
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

  // New-contact form
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);

  // Reset on open/close so a stale search/selection doesn't leak into
  // the next time the agent opens this modal.
  useEffect(() => {
    if (!open) return;
    setMode("existing");
    setSearch("");
    setResults([]);
    setSelectedContact(null);
    setName("");
    setPhone("");
    setDupMatch(null);
  }, [open]);

  // Live contact search — small accounts, cheap enough to query on every
  // keystroke rather than add a debounce dependency. Strips `,()` before
  // building the `.or()` filter string since those are PostgREST
  // filter-grammar special characters, not meaningful in a name/phone
  // query.
  useEffect(() => {
    if (!open || mode !== "existing" || !accountId) return;
    const q = search.trim().replace(/[,()]/g, "");
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .order("name")
        .limit(20);
      if (!cancelled) {
        setResults((data as Contact[]) ?? []);
        setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, mode, search, accountId, supabase]);

  const checkNewContactDuplicate = useCallback(async () => {
    if (!accountId) return;
    const digits = normalizePhone(phone);
    if (!digits) {
      setDupMatch(null);
      return;
    }
    const canonicalPhone = `+${digits}`;
    const existing = await findExistingContact(supabase, accountId, canonicalPhone);
    setDupMatch(
      existing
        ? { contact: existing, exact: isExactMatch(existing, canonicalPhone) }
        : null,
    );
  }, [accountId, phone, supabase]);

  const openConversationForContact = useCallback(
    async (contactId: string) => {
      if (!accountId || !user) return;
      const result = await findOrCreateConversationForContact(
        supabase,
        accountId,
        user.id,
        contactId,
      );
      if (!result) {
        toast.error("Não foi possível abrir a conversa. Tente novamente.");
        return;
      }
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", result.id)
        .maybeSingle();
      if (error || !data) {
        toast.error("Conversa criada, mas falhou ao carregar. Atualize a página.");
        return;
      }
      onCreated(normalizeConversation(data));
      onOpenChange(false);
    },
    [accountId, user, supabase, onCreated, onOpenChange],
  );

  const handleSubmitExisting = useCallback(async () => {
    if (!selectedContact || submitting) return;
    setSubmitting(true);
    try {
      await openConversationForContact(selectedContact.id);
    } finally {
      setSubmitting(false);
    }
  }, [selectedContact, submitting, openConversationForContact]);

  const handleSubmitNew = useCallback(async () => {
    if (submitting || !accountId || !user) return;

    // Accepts spaces, parens, dashes, "+" as typed — normalize to
    // digits-only, validate 7–15 digits starting with 1–9, then store
    // the canonical "+<digits>" form. Never the raw formatted input.
    const digits = normalizePhone(phone);
    if (!digits) {
      toast.error("Informe o telefone.");
      return;
    }
    if (!isValidE164(digits)) {
      toast.error("Telefone inválido. Use o formato internacional, ex: +5511999999999.");
      return;
    }
    const canonicalPhone = `+${digits}`;

    setSubmitting(true);
    try {
      // Dedup first — if this number already belongs to a contact in
      // this account, reuse it instead of creating a duplicate. Looks
      // up by the same canonical form that gets stored, not the raw
      // formatted input.
      const existing = await findExistingContact(supabase, accountId, canonicalPhone);
      if (existing) {
        await openConversationForContact(existing.id);
        return;
      }

      const { data: created, error } = await supabase
        .from("contacts")
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: name.trim() || null,
          phone: canonicalPhone,
        })
        .select("id")
        .single();

      if (error) {
        // Race: another insert claimed this number between our check
        // and this insert. Same recovery as ContactForm.
        if (isUniqueViolation(error)) {
          const raced = await findExistingContact(supabase, accountId, canonicalPhone);
          if (raced) {
            await openConversationForContact(raced.id);
            return;
          }
        }
        throw error;
      }

      await openConversationForContact(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao criar o contato.";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, accountId, user, phone, name, supabase, openConversationForContact]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Nova conversa</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Selecione um contato existente ou crie um novo para iniciar um atendimento.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-md bg-muted p-1">
          <button
            type="button"
            onClick={() => setMode("existing")}
            className={cn(
              "flex-1 rounded px-2 py-1.5 text-sm transition-colors",
              mode === "existing"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Contato existente
          </button>
          <button
            type="button"
            onClick={() => setMode("new")}
            className={cn(
              "flex-1 rounded px-2 py-1.5 text-sm transition-colors",
              mode === "new"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Novo contato
          </button>
        </div>

        {mode === "existing" ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelectedContact(null);
                }}
                placeholder="Buscar por nome ou telefone…"
                className="bg-muted border-border pl-9 text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="max-h-64 space-y-1 overflow-y-auto">
              {searching ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : results.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {search.trim()
                    ? "Nenhum contato encontrado."
                    : "Digite para buscar um contato."}
                </p>
              ) : (
                results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedContact(c)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      selectedContact?.id === c.id
                        ? "bg-primary/10 text-foreground ring-1 ring-primary/40"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <span className="truncate font-medium">{c.name || c.phone}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{c.phone}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Nome</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome do contato (opcional)"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Telefone <span className="text-red-400">*</span>
              </Label>
              <Input
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (dupMatch) setDupMatch(null);
                }}
                onBlur={checkNewContactDuplicate}
                placeholder="+55 11 99999-9999"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              {dupMatch ? (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
                    dupMatch.exact
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300",
                  )}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {dupMatch.exact
                      ? `Já existe um contato com este número (${dupMatch.contact.name || dupMatch.contact.phone}) — a conversa dele será aberta.`
                      : "Um contato com número parecido já existe."}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Formato internacional, ex: +5511999999999.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="bg-popover border-border">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={
              submitting ||
              (mode === "existing" ? !selectedContact : !phone.trim())
            }
            onClick={mode === "existing" ? handleSubmitExisting : handleSubmitNew}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting && <Loader2 className="mr-1 size-4 animate-spin" />}
            <UserPlus className="mr-1 size-4" />
            Iniciar conversa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
