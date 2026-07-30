/**
 * UAZAPI helpers — the unofficial, QR-code-based WhatsApp connection.
 *
 * Mirrors the conventions of `meta-api.ts`: every function takes a
 * single options object (named parameters), does a plain `fetch`
 * with no DB access, and throws a plain `Error` with a readable
 * message on a non-2xx response.
 *
 * Two different auth headers are in play, matching UAZAPI's own
 * split between admin and instance scope:
 *   - `admintoken` — your reseller/admin credential (env
 *     `UAZAPI_ADMIN_TOKEN`). Only `createInstance` uses it.
 *   - `token` — the token of one specific instance, returned by
 *     `createInstance` and stored (encrypted) per account. Every
 *     other call uses it.
 */

import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from './meta-api'

export type { MediaKind }

function uazapiServerUrl(): string {
  const url = process.env.UAZAPI_SERVER_URL
  if (!url) {
    throw new Error(
      'UAZAPI_SERVER_URL is not configured. Set it in your environment to use the UAZAPI connection.',
    )
  }
  return url.replace(/\/+$/, '')
}

function uazapiAdminToken(): string {
  const token = process.env.UAZAPI_ADMIN_TOKEN
  if (!token) {
    throw new Error(
      'UAZAPI_ADMIN_TOKEN is not configured. Set it in your environment to use the UAZAPI connection.',
    )
  }
  return token
}

interface UazapiErrorBody {
  error?: string
  message?: string
  message_ptbr?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorBody
    message = data.error || data.message_ptbr || data.message || fallback
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

// ============================================================
// Timeout handling
//
// Every UAZAPI call gets an upper-bound timeout so a stuck instance
// or slow network never hangs a request indefinitely (previously
// unbounded). A caller-supplied AbortSignal (if any) is composed
// with our own, not overwritten — aborting the caller's signal still
// aborts the request; our timeout is an additional ceiling.
// ============================================================

const UAZAPI_DEFAULT_TIMEOUT_MS = 15_000
const UAZAPI_MEDIA_TIMEOUT_MS = 60_000

export class UazapiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`UAZAPI request timed out after ${timeoutMs}ms`)
    this.name = 'UazapiTimeoutError'
  }
}

async function uazapiFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false

  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    // Distinguish OUR timeout from a caller-initiated abort or a
    // genuine network failure — only the timeout case gets rewrapped;
    // everything else propagates unchanged.
    if (timedOut) {
      throw new UazapiTimeoutError(timeoutMs)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

// ============================================================
// Instance status
// ============================================================

export type UazapiInstanceStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated'

const KNOWN_INSTANCE_STATUSES: readonly UazapiInstanceStatus[] = [
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
]

/**
 * Normalize casing/whitespace on UAZAPI's `status` field and fall
 * back to the conservative 'disconnected' for anything we don't
 * recognize — never reports 'connected' on a value we can't verify.
 * Logs only the offending status string, never the full payload.
 */
function normalizeInstanceStatus(raw: unknown): UazapiInstanceStatus {
  const value = String(raw ?? '').trim().toLowerCase()
  if ((KNOWN_INSTANCE_STATUSES as readonly string[]).includes(value)) {
    return value as UazapiInstanceStatus
  }
  console.warn(
    `[uazapi-api] unrecognized instance status: "${value}" — treating as disconnected`,
  )
  return 'disconnected'
}

export interface UazapiSendResult {
  messageId: string
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateInstanceArgs {
  /** Display name for the instance (shown in the UAZAPI panel). */
  name: string
  signal?: AbortSignal
}

export interface CreateInstanceResult {
  instanceId: string
  instanceToken: string
}

/**
 * Provision a brand-new UAZAPI instance under our admin/reseller
 * account. Each account gets its own instance the first time it
 * connects via UAZAPI — calling this again for an account that
 * already has one would orphan the previous instance, so callers
 * must check for an existing `uazapi_instance_id` first.
 */
export async function createInstance(
  args: CreateInstanceArgs,
): Promise<CreateInstanceResult> {
  const { name, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/instance/init`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        admintoken: uazapiAdminToken(),
      },
      body: JSON.stringify({ name, systemName: name }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  const instance = data?.instance
  if (!instance?.id || !instance?.token) {
    throw new Error('UAZAPI did not return an instance id/token.')
  }
  return { instanceId: String(instance.id), instanceToken: String(instance.token) }
}

export interface ConnectInstanceArgs {
  instanceToken: string
  signal?: AbortSignal
}

export interface ConnectInstanceResult {
  status: UazapiInstanceStatus
  qrcode?: string
  paircode?: string
}

/**
 * Start (or resume) the QR-code connection flow for an instance.
 * Returns a `qrcode` data URI for the front end to render — the
 * customer scans it with WhatsApp on their phone. Meanwhile
 * `getInstanceStatus` should be polled until it reports `connected`.
 */
export async function connectInstance(
  args: ConnectInstanceArgs,
): Promise<ConnectInstanceResult> {
  const { instanceToken, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/instance/connect`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({ browser: 'auto' }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  const instance = data?.instance ?? {}
  return {
    status: normalizeInstanceStatus(instance.status ?? data?.status),
    qrcode: instance.qrcode || undefined,
    paircode: instance.paircode || undefined,
  }
}

export interface GetInstanceStatusArgs {
  instanceToken: string
  signal?: AbortSignal
}

export interface GetInstanceStatusResult {
  status: UazapiInstanceStatus
  connected: boolean
  loggedIn: boolean
  qrcode?: string
}

/** Poll the current connection state of an instance. */
export async function getInstanceStatus(
  args: GetInstanceStatusArgs,
): Promise<GetInstanceStatusResult> {
  const { instanceToken, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/instance/status`,
    { headers: { token: instanceToken } },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  const instance = data?.instance ?? {}
  return {
    status: normalizeInstanceStatus(instance.status),
    connected: Boolean(data?.connected),
    loggedIn: Boolean(data?.loggedIn),
    qrcode: instance.qrcode || undefined,
  }
}

export interface ConfigureWebhookArgs {
  instanceToken: string
  url: string
  events: string[]
  /** e.g. ['wasSentByApi'] to avoid echo loops on our own outbound sends. */
  excludeMessages?: string[]
  signal?: AbortSignal
}

/**
 * Register the URL UAZAPI should POST inbound events to. Uses the
 * "simple mode" (no `action`/`id`) — one webhook per instance,
 * created or updated automatically.
 */
export async function configureWebhook(args: ConfigureWebhookArgs): Promise<void> {
  const { instanceToken, url, events, excludeMessages, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/webhook`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({ url, events, excludeMessages: excludeMessages ?? [] }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
}

// ============================================================
// Sending
// ============================================================

export interface UazapiSendTextArgs {
  instanceToken: string
  to: string
  text: string
  /** UAZAPI's message id to reply to (renders as a quoted reply). */
  contextMessageId?: string
  signal?: AbortSignal
}

export async function sendTextMessage(
  args: UazapiSendTextArgs,
): Promise<UazapiSendResult> {
  const { instanceToken, to, text, contextMessageId, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/send/text`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({
        number: to,
        text,
        ...(contextMessageId ? { replyid: contextMessageId } : {}),
      }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: String(data.messageid ?? data.id) }
}

export interface UazapiSendMediaArgs {
  instanceToken: string
  to: string
  kind: MediaKind
  /** Public URL UAZAPI fetches at send time. */
  link: string
  caption?: string
  /** Document-only. */
  filename?: string
  contextMessageId?: string
  signal?: AbortSignal
}

/**
 * Send an image / video / document / audio via a public URL.
 * `kind` maps 1:1 onto UAZAPI's `/send/media` `type` field — no
 * translation needed, the values match `MEDIA_KINDS` exactly.
 *
 * Uses the longer media timeout — UAZAPI fetches the file from
 * `link` server-side before it can respond, which can take longer
 * than a plain text/status call.
 */
export async function sendMediaMessage(
  args: UazapiSendMediaArgs,
): Promise<UazapiSendResult> {
  const { instanceToken, to, kind, link, caption, filename, contextMessageId, signal } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/send/media`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({
        number: to,
        type: kind,
        file: link,
        ...(caption ? { text: caption } : {}),
        ...(kind === 'document' && filename ? { docName: filename } : {}),
        ...(contextMessageId ? { replyid: contextMessageId } : {}),
      }),
    },
    UAZAPI_MEDIA_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: String(data.messageid ?? data.id) }
}

/** `"texto|id"` — UAZAPI's pipe-separated choice format. */
function formatChoice(label: string, id: string): string {
  return `${label}|${id}`
}

export interface UazapiSendInteractiveButtonsArgs {
  instanceToken: string
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
  signal?: AbortSignal
}

/**
 * Send a button menu via UAZAPI's unified `/send/menu` endpoint
 * (`type: "button"`). `headerText` has no button-menu equivalent on
 * UAZAPI (only `imageButton`, which we don't use here) — dropped
 * silently, matching how `/send/menu` itself ignores unknown fields.
 */
export async function sendInteractiveButtons(
  args: UazapiSendInteractiveButtonsArgs,
): Promise<UazapiSendResult> {
  const { instanceToken, to, bodyText, footerText, buttons, contextMessageId, signal } = args
  if (buttons.length < 1) throw new Error('Interactive button message requires at least 1 button.')
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/send/menu`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({
        number: to,
        type: 'button',
        text: bodyText,
        choices: buttons.map((b) => formatChoice(b.title, b.id)),
        ...(footerText ? { footerText } : {}),
        ...(contextMessageId ? { replyid: contextMessageId } : {}),
      }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: String(data.messageid ?? data.id) }
}

export interface UazapiSendInteractiveListArgs {
  instanceToken: string
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
  signal?: AbortSignal
}

/**
 * Send a list menu via UAZAPI's unified `/send/menu` endpoint
 * (`type: "list"`). Sections render as `"[Title]"` markers followed
 * by `"texto|id|descrição"` rows, per UAZAPI's `choices` format.
 */
export async function sendInteractiveList(
  args: UazapiSendInteractiveListArgs,
): Promise<UazapiSendResult> {
  const { instanceToken, to, bodyText, buttonLabel, footerText, sections, contextMessageId, signal } = args
  const choices: string[] = []
  for (const section of sections) {
    if (section.title) choices.push(`[${section.title}]`)
    for (const row of section.rows) {
      choices.push(
        row.description
          ? `${row.title}|${row.id}|${row.description}`
          : formatChoice(row.title, row.id),
      )
    }
  }
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/send/menu`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({
        number: to,
        type: 'list',
        text: bodyText,
        listButton: buttonLabel,
        choices,
        ...(footerText ? { footerText } : {}),
        ...(contextMessageId ? { replyid: contextMessageId } : {}),
      }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: String(data.messageid ?? data.id) }
}
