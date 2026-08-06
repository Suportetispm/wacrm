import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Formats a byte count as a human-readable size (e.g. "1.4 MB"). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

/**
 * Strips control characters and collapses whitespace from a
 * server-provided file name before it's shown in the UI. React already
 * escapes JSX text content, so this is defense-in-depth against
 * unusual bytes rather than an XSS fix in itself.
 */
export function sanitizeFileName(name: string, maxLength = 60): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 1)}…`
}
