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

/**
 * Preserves the real UAZAPI HTTP status code, so route handlers can
 * tell "auth/not-found" (401/403/404 — the instance is gone/invalid)
 * apart from any other failure (which stays a generic, transient-
 * looking error). Previously this collapsed to a plain `Error`,
 * losing the status entirely.
 */
export class UazapiHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'UazapiHttpError'
    this.status = status
  }
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorBody
    message = data.error || data.message_ptbr || data.message || fallback
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new UazapiHttpError(response.status, message)
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
 *
 * ETAPA 8.1H: both `token` (instance) and `admintoken` (admin) were
 * tried against this account's configured server and both returned a
 * real 401 from UAZAPI — the auth-header hypothesis is not confirmed
 * either way. Reverted to `token`/`instanceToken` (the pre-8.1G
 * state) rather than leaving `admintoken` in place on unconfirmed
 * grounds. The real contract for this endpoint on THIS server is
 * still unknown; see the ETAPA 8.1H diagnosis for next steps
 * (checking the instance's own web panel / a real network trace)
 * before trying another credential guess.
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
      body: JSON.stringify({
        enabled: true,
        url,
        events,
        excludeMessages: excludeMessages ?? [],
      }),
    },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
}

export interface GetWebhookConfigurationArgs {
  instanceToken: string
  signal?: AbortSignal
}

/** The subset of UAZAPI's `Webhook` object this app currently reads. */
export interface UazapiWebhookConfig {
  enabled: boolean
  url: string
  events: string[]
}

/**
 * Read-only lookup of the instance's current webhook configuration.
 * Sends no body, changes nothing server-side. UAZAPI's "simple mode"
 * (the mode `configureWebhook` writes in) returns at most one entry;
 * an empty array means no webhook has been configured yet.
 */
export async function getWebhookConfiguration(
  args: GetWebhookConfigurationArgs,
): Promise<UazapiWebhookConfig[]> {
  const { instanceToken, signal } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/webhook`,
    { headers: { token: instanceToken } },
    UAZAPI_DEFAULT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = await response.json()
  if (!Array.isArray(data)) return []
  return data.map((item) => ({
    enabled: Boolean(item?.enabled),
    url: typeof item?.url === 'string' ? item.url : '',
    events: Array.isArray(item?.events)
      ? item.events.filter((e: unknown): e is string => typeof e === 'string')
      : [],
  }))
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

// ============================================================
// Message actions
// ============================================================

/**
 * The real limit that matters: the actual file content, once decoded.
 * Exported so callers (e.g. a persistence flow validating a declared
 * `fileLength` before even downloading) can check against the exact
 * same ceiling instead of hardcoding a second copy of it.
 */
export const UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES = 20 * 1024 * 1024

/**
 * Raw HTTP/JSON body cap — deliberately larger than the decoded-bytes
 * limit above. Base64 inflates by ~4/3, so a file at the 20 MB decoded
 * ceiling needs ~26.7 MB of base64 text alone; capping the raw body at
 * the same 20 MB as the decoded limit (the previous version of this
 * file did that) would reject every legitimate file anywhere near the
 * ceiling before the decoded-size check ever got a chance to run. 28
 * MB leaves a small margin on top of the ~26.7 MB floor for JSON
 * framing (field names, fileURL, mimetype, transcription).
 */
const UAZAPI_MEDIA_DOWNLOAD_MAX_BODY_BYTES = 28 * 1024 * 1024

/**
 * Reads a response body with an upper bound on size, so a caller
 * requesting `returnBase64: true` on a large file can't force
 * unbounded memory growth. Content-Length is checked first when
 * present, but never trusted alone (absent on chunked transfers, and
 * a misbehaving server could send a smaller value than the real
 * body) — the actual decoded text length is always re-checked too.
 */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`UAZAPI response exceeded the ${maxBytes}-byte limit`)
  }
  const text = await response.text()
  if (text.length > maxBytes) {
    throw new Error(`UAZAPI response exceeded the ${maxBytes}-byte limit`)
  }
  return text ? JSON.parse(text) : null
}

/**
 * Exact decoded byte length of a base64 string, derived from its
 * length and padding — no decode/allocation needed. Lets a caller
 * reject an oversized `base64Data` field without ever holding a
 * buffer as large as the limit it's enforcing.
 */
export function estimateBase64DecodedBytes(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

export interface DownloadMessageMediaArgs {
  instanceToken: string
  /** UAZAPI message id whose media should be downloaded. */
  id: string
  /** Also return the file content inline as base64. */
  returnBase64?: boolean
  /** For audio messages: true = MP3, false = OGG. */
  generateMp3?: boolean
  /** Save and return a public URL for the file. */
  returnLink?: boolean
  /** Transcribe audio messages to text. */
  transcribe?: boolean
  /** OpenAI API key for transcription; omit to use the one saved on the instance. */
  openaiApiKey?: string
  /** Download the media from the quoted/replied-to message instead of this one. */
  downloadQuoted?: boolean
  signal?: AbortSignal
}

export interface DownloadMessageMediaResult {
  fileUrl?: string
  mimetype?: string
  base64Data?: string
  transcription?: string
}

/**
 * Wraps `POST /message/download`. Returns whatever combination of
 * `fileURL` / `base64Data` / `transcription` UAZAPI sends back for
 * the requested flags. Does no persistence, no disk writes, and logs
 * nothing — the media URL, any base64 payload, and the instance token
 * must never end up in logs or error messages.
 */
export async function downloadMessageMedia(
  args: DownloadMessageMediaArgs,
): Promise<DownloadMessageMediaResult> {
  const {
    instanceToken,
    id,
    returnBase64,
    generateMp3,
    returnLink,
    transcribe,
    openaiApiKey,
    downloadQuoted,
    signal,
  } = args
  const response = await uazapiFetch(
    `${uazapiServerUrl()}/message/download`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: instanceToken,
      },
      body: JSON.stringify({
        id,
        ...(returnBase64 !== undefined ? { return_base64: returnBase64 } : {}),
        ...(generateMp3 !== undefined ? { generate_mp3: generateMp3 } : {}),
        ...(returnLink !== undefined ? { return_link: returnLink } : {}),
        ...(transcribe !== undefined ? { transcribe } : {}),
        ...(openaiApiKey ? { openai_apikey: openaiApiKey } : {}),
        ...(downloadQuoted !== undefined ? { download_quoted: downloadQuoted } : {}),
      }),
    },
    UAZAPI_MEDIA_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  const data = (await readBoundedJson(response, UAZAPI_MEDIA_DOWNLOAD_MAX_BODY_BYTES)) as
    | Record<string, unknown>
    | null
  const base64Data = typeof data?.base64Data === 'string' ? data.base64Data : undefined
  if (
    base64Data &&
    estimateBase64DecodedBytes(base64Data) > UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES
  ) {
    throw new Error(
      `UAZAPI media download exceeded the ${UAZAPI_MEDIA_DOWNLOAD_MAX_DECODED_BYTES}-byte limit after decoding`,
    )
  }
  return {
    fileUrl: typeof data?.fileURL === 'string' ? data.fileURL : undefined,
    mimetype: typeof data?.mimetype === 'string' ? data.mimetype : undefined,
    base64Data,
    transcription: typeof data?.transcription === 'string' ? data.transcription : undefined,
  }
}
