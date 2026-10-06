"use client";

import { useState, type ReactNode } from "react";

/**
 * Ordered image sources for a contact avatar:
 *   1. the synced WhatsApp photo (migration 085), always through our own
 *      authenticated route — the browser never talks to UAZAPI/WhatsApp.
 *      `?v=` is the content hash from the stored path, so a changed photo
 *      is a new URL (cache-safe) and an unchanged one stays cacheable;
 *   2. the legacy `avatar_url`, when set;
 * then the caller's fallback (initials).
 */
export function contactAvatarSources(contact: {
  id?: string | null;
  whatsapp_avatar_path?: string | null;
  avatar_url?: string | null;
}): string[] {
  const sources: string[] = [];
  if (contact.id && contact.whatsapp_avatar_path) {
    const version = /([0-9a-f]{64})\.(?:jpg|png|webp)$/.exec(contact.whatsapp_avatar_path)?.[1];
    if (version) {
      sources.push(`/api/contacts/${encodeURIComponent(contact.id)}/avatar?v=${version.slice(0, 16)}`);
    }
  }
  if (contact.avatar_url) sources.push(contact.avatar_url);
  return sources;
}

/** First source that hasn't failed yet; null = show the fallback. Failed sources are never retried (no loop). */
export function pickAvatarSource(sources: string[], failed: ReadonlySet<string>): string | null {
  return sources.find((s) => !failed.has(s)) ?? null;
}

/**
 * Renders the contact's photo, or `fallback` (the caller's existing
 * initials markup) when there is none or every image failed to load.
 * Only renders the INNER content — each call site keeps its own wrapper
 * (size, shape, colors), so no layout changes.
 */
export function ContactAvatar({
  contact,
  alt,
  fallback,
  imgClassName,
}: {
  contact: { id?: string | null; whatsapp_avatar_path?: string | null; avatar_url?: string | null } | null | undefined;
  alt: string;
  fallback: ReactNode;
  imgClassName: string;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const src = contact ? pickAvatarSource(contactAvatarSources(contact), failed) : null;

  if (!src) return <>{fallback}</>;

  return (
    <img
      key={src}
      src={src}
      alt={alt}
      className={imgClassName}
      loading="lazy"
      decoding="async"
      onError={() => setFailed((prev) => new Set(prev).add(src))}
    />
  );
}
