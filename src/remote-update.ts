// Updating the hub from the connecting Mac (#637), the viewer's half. VIEWER PROCESS ONLY: nothing
// in the stdio MCP server's import graph may reach this module (test/prstate.test.ts).
//
// The hub's own update controller (electron/update-controller.cjs) lives in the desktop app's main
// process, so the viewer only relays. Main reports what a paired device may see every few seconds
// on the loopback route POST /api/remote-entry/update, with the owner token, and hears back the one
// request a device made since. A paired device reads that report with GET /api/remote/update and
// asks for an update with POST /api/remote/update, both on the remote entry only, behind the whole
// gate (src/viewer-remote.ts). The request carries nothing: no version, URL or file. Main decides
// again, on its own state, and installs only the release its own controller verified
// (electron/remote-update.cjs). Architecture notes: docs/architecture/remote-inbox.md.
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Handler } from 'hono'
import { ownerTokenMatches } from './remote-pair.js'

/** On the remote entry only, registered by guardRemoteApp after the gate. Main's report comes on the
 *  loopback app's POST /api/remote-entry/update, only with the owner token (src/viewer-server.ts). */
export const UPDATE_PATH = '/api/remote/update'

const STATUSES = ['current', 'checking', 'available', 'downloading', 'installing', 'failed'] as const
const REASONS = ['setup_running', 'installing', 'not_here', 'nothing_newer', 'busy'] as const
const KEYS = ['canStart', 'current', 'newer', 'reason', 'status']
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// main reports every few seconds: an older report is not the hub's state any more
const FRESH_MS = 15_000
const REPORT_MAX = 1024

export interface UpdateSummary {
  /** the hub's running version */
  current: string
  status: typeof STATUSES[number]
  /** the newer release the hub's controller verified, or null */
  newer: string | null
  canStart: boolean
  /** why a start would be refused; `not_ready` is the viewer's own: main has not reported lately */
  reason: typeof REASONS[number] | 'not_ready' | null
}

export interface UpdateRequest {
  id: string
  /** the paired device that asked, by its remote.json id */
  device: string
}

const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value)

/** Main's report, exactly: the five keys, a start only with a newer version and no reason, a refusal always with one. */
export function parseSummary(value: unknown): UpdateSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const given = value as Record<string, unknown>
  if (Object.keys(given).sort().join(',') !== KEYS.join(',')) return null
  const { current, status, newer, canStart, reason } = given
  if (!isVersion(current) || !(STATUSES as readonly unknown[]).includes(status)) return null
  if (newer !== null && !isVersion(newer)) return null
  if (canStart === true) {
    if (newer === null || reason !== null) return null
  } else if (canStart !== false || !(REASONS as readonly unknown[]).includes(reason)) {
    return null
  }
  return { current, status, newer, canStart, reason } as UpdateSummary
}

export interface RemoteUpdate {
  summary(): UpdateSummary
  /** a paired device's read; main hears that someone looked */
  get(): UpdateSummary
  /** a paired device's request, recorded for main, or why not */
  start(device: string): { ok: true } | { ok: false; reason: string }
  /** main's report; answers the request made since the last one (once) and whether a device looked */
  report(summary: UpdateSummary): { request: UpdateRequest | null; looked: boolean }
}

export function createRemoteUpdate(opts: { version: string; now?: () => number; randomId?: () => string }): RemoteUpdate {
  const now = opts.now ?? Date.now
  const randomId = opts.randomId ?? (() => crypto.randomBytes(8).toString('hex'))
  let reported: { summary: UpdateSummary; at: number } | null = null
  let request: UpdateRequest | null = null
  let looked = false
  // between a request and main's next report, the hub is already on its way
  const asked = (summary: UpdateSummary): UpdateSummary => ({ ...summary, status: 'installing', canStart: false, reason: 'installing' })

  function summary(): UpdateSummary {
    const t = now()
    if (reported === null || t < reported.at || t - reported.at > FRESH_MS) {
      return { current: opts.version, status: 'current', newer: null, canStart: false, reason: 'not_ready' }
    }
    return { ...reported.summary }
  }

  return {
    summary,
    get() {
      looked = true
      return summary()
    },
    start(device) {
      const current = summary()
      if (request !== null) return { ok: false, reason: 'installing' }
      if (!current.canStart) return { ok: false, reason: current.reason ?? 'busy' }
      request = { id: randomId(), device }
      reported = { summary: asked(current), at: reported!.at }
      return { ok: true }
    },
    report(next) {
      const handed = request
      const sawLook = looked
      request = null
      looked = false
      reported = { summary: handed === null ? { ...next } : asked(next), at: now() }
      return { request: handed, looked: sawLook }
    },
  }
}

/**
 * The remote entry's two routes, registered on the guarded app after the gate (guardRemoteApp), so
 * every request has passed it with a paired device's secret; `deviceOf` names that device. A POST
 * that names anything (a query, a body) is refused: the hub decides what is installed.
 */
export function remoteUpdateRoutes(update: RemoteUpdate, deviceOf: (incoming: IncomingMessage | undefined) => string | null): { get: Handler; post: Handler } {
  const incomingOf = (env: unknown) => (env as { incoming?: IncomingMessage } | undefined)?.incoming
  return {
    get: (c) => {
      if (deviceOf(incomingOf(c.env)) === null) return c.text('Forbidden', 403)
      return c.json(update.get())
    },
    post: (c) => {
      const incoming = incomingOf(c.env)
      const device = deviceOf(incoming)
      if (device === null) return c.text('Forbidden', 403)
      const length = incoming?.headers['content-length']
      if (incoming?.url !== UPDATE_PATH || (length !== undefined && length !== '0') || incoming.headers['transfer-encoding'] !== undefined) {
        return c.json({ ok: false, reason: 'bad_request' }, 400)
      }
      const started = update.start(device)
      return started.ok ? c.json(started, 202) : c.json(started, 409)
    },
  }
}

/** POST /api/remote-entry/update on the loopback app: main's report, with the owner token; the request since, if any. */
export function remoteUpdateReportRoute(update: RemoteUpdate, ownerToken: string): Handler {
  return async (c) => {
    if (!ownerTokenMatches(c.req.header('x-agent-inbox-owner'), ownerToken)) return c.text('Forbidden', 403)
    // main always sends its length; a body with none, or a longer one, is never read
    const length = c.req.header('content-length')
    const text = length !== undefined && /^\d{1,4}$/.test(length) && Number(length) <= REPORT_MAX ? await c.req.text() : null
    let summary: UpdateSummary | null = null
    if (text !== null && text.length <= REPORT_MAX) {
      try {
        summary = parseSummary(JSON.parse(text))
      } catch {
        summary = null
      }
    }
    if (summary === null) return c.json({ error: 'bad_report' }, 400, { 'Cache-Control': 'no-store' })
    return c.json(update.report(summary), 200, { 'Cache-Control': 'no-store' })
  }
}
