"use client";

import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { avatarVersionFromPath } from "@/lib/inbox/contact-avatar-sync-shared";

type AvatarContact = {
  id?: string | null;
  whatsapp_avatar_path?: string | null;
  /** Client-only version from POST /api/contacts/avatar-sync; overrides the path-derived one when present. */
  whatsapp_avatar_version?: string | null;
  avatar_url?: string | null;
};

/** URL of the synced WhatsApp photo (our authenticated route), or null when there is none. */
export function syncedAvatarSource(contact: AvatarContact): string | null {
  if (!contact.id) return null;
  const version =
    contact.whatsapp_avatar_version !== undefined
      ? contact.whatsapp_avatar_version
      : avatarVersionFromPath(contact.whatsapp_avatar_path);
  if (!version || !/^[0-9a-f]{16}$/.test(version)) return null;
  return `/api/contacts/${encodeURIComponent(contact.id)}/avatar?v=${version}`;
}

/**
 * Ordered image sources for a contact avatar:
 *   1. the synced WhatsApp photo (migration 085), always through our own
 *      authenticated route — the browser never talks to UAZAPI/WhatsApp.
 *      `?v=` is an opaque content-hash prefix, so a changed photo is a
 *      new URL (cache-safe);
 *   2. the legacy `avatar_url`, when set;
 * then the caller's fallback (initials).
 */
export function contactAvatarSources(contact: AvatarContact): string[] {
  const sources: string[] = [];
  const synced = syncedAvatarSource(contact);
  if (synced) sources.push(synced);
  if (contact.avatar_url) sources.push(contact.avatar_url);
  return sources;
}

/** First source that hasn't failed yet; null = show the fallback. Failed sources are never retried (no loop). */
export function pickAvatarSource(sources: string[], failed: ReadonlySet<string>): string | null {
  return sources.find((s) => !failed.has(s)) ?? null;
}

/** Only the synced WhatsApp photo, once it has actually loaded, may be enlarged — never the legacy URL or initials. */
export function canZoomAvatar(contact: AvatarContact, src: string | null, loadedSrc: string | null): boolean {
  return src !== null && src === syncedAvatarSource(contact) && loadedSrc === src;
}

export interface ContactAvatarZoom {
  /** Accessible name of the trigger, e.g. "Ver foto de Maria". */
  openLabel: string;
  /** Accessible title of the dialog. */
  title: string;
  closeLabel: string;
}

/**
 * Renders the contact's photo, or `fallback` (the caller's existing
 * initials markup) when there is none or every image failed to load.
 * Only renders the INNER content — each call site keeps its own wrapper
 * (size, shape, colors), so no layout changes.
 *
 * With `zoom`, the synced WhatsApp photo (and only it) becomes a button
 * that opens it enlarged in a dialog, through the same authenticated
 * route. Never pass `zoom` inside an already-interactive element (e.g.
 * the conversation-list row).
 */
export function ContactAvatar({
  contact,
  alt,
  fallback,
  imgClassName,
  zoom,
}: {
  contact: AvatarContact | null | undefined;
  alt: string;
  fallback: ReactNode;
  imgClassName: string;
  zoom?: ContactAvatarZoom;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const src = contact ? pickAvatarSource(contactAvatarSources(contact), failed) : null;

  if (!src) return <>{fallback}</>;

  const markFailed = () => {
    setFailed((prev) => new Set(prev).add(src));
    setOpen(false);
  };

  const img = (
    <img
      key={src}
      src={src}
      alt={alt}
      className={imgClassName}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoadedSrc(src)}
      onError={markFailed}
    />
  );

  if (!zoom || !contact || src !== syncedAvatarSource(contact)) return img;

  const zoomable = canZoomAvatar(contact, src, loadedSrc);

  return (
    <>
      <button
        type="button"
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default enabled:cursor-zoom-in"
        aria-label={zoom.openLabel}
        aria-haspopup="dialog"
        disabled={!zoomable}
        onClick={() => setOpen(true)}
      >
        {img}
      </button>
      {zoomable && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            overlayClassName="bg-black/80 supports-backdrop-filter:backdrop-blur-none"
            className="w-auto max-w-[calc(100%-2rem)] bg-transparent p-0 ring-0 sm:max-w-[min(90vw,640px)]"
          >
            <DialogTitle className="sr-only">{zoom.title}</DialogTitle>
            <img
              src={src}
              alt={alt}
              className="max-h-[80vh] w-full max-w-[min(90vw,640px)] rounded-lg object-contain"
              onError={markFailed}
            />
            <DialogClose
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-2 right-2 rounded-full"
                  aria-label={zoom.closeLabel}
                />
              }
            >
              <XIcon />
            </DialogClose>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
