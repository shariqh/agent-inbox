// Pairing a device with the remote entry (#617, PR 2b). VIEWER PROCESS ONLY: nothing in the stdio
// MCP server's import graph may reach this module (test/prstate.test.ts). src/viewer-remote.ts
// wires it into the remote entry's gate (step 7); src/viewer-server.ts registers the code route on
// the loopback app.
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Pairing"; architecture
// notes in docs/architecture/remote-inbox.md. The hub makes a short one-time code, in memory only;
// another Mac sends it once to POST /api/remote/pair and gets back a device secret that the gate's
// step 8 accepts from then on. Agents on the hub may run commands without asking, so a device
// secret is a credential for the whole hub: every refusal here is the same bare 403, and nothing
// here logs the code, the secret, a hash, a label, a login or a header value.
import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import type { Context, Handler } from 'hono'

// The lock main uses for its own files (temp file and rename in the same folder, mode 0600, a
// sibling `.lock` across processes), so the viewer and main never write remote.json at once. It
// needs nothing from Electron: node:fs/promises, node:path and node:crypto only.
const require = createRequire(import.meta.url)
const { createLockedFile } = require('../electron/update-preferences.cjs') as {
  createLockedFile: (filePath: string, fsImpl: typeof fsPromises) => {
    atomicWrite(value: unknown): Promise<void>
    mutate<T>(operation: () => Promise<T>): Promise<T>
  }
}

/** The one route that passes the gate with the login alone: this method and exactly this request target. */
export const PAIR_PATH = '/api/remote/pair'

// Crockford base32: no I, L, O or U
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 10
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/
// what a person may type: ASCII letters, digits, spaces and dashes, before normalising
const CODE_TYPED = /^[0-9A-Za-z -]{1,64}$/
const CODE_TTL_MS = 10 * 60_000
const CODE_TRIES = 5
const PAIR_LIMIT = 10
const PAIR_WINDOW_MS = 60_000
const BODY_MAX = 1024
const MAX_DEVICES = 16
const PAIRED_SHOWN = 16
const LABEL_MAX = 40
// A label is read by a person (Settings, a notification), so besides control characters (Cc) it
// may hold no Unicode format character (Cf: bidirectional controls, zero-width characters, the
// byte-order mark, a zero-width joiner even inside an emoji sequence, the soft hyphen) and no half
// of a surrogate pair (Cs), which JSON can carry.
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u

/**
 * A device label, by the one rule the pairing request and remote.json's reader
 * (src/viewer-remote.ts) both use: a string of 1 to 40 characters with none of LABEL_FORBIDDEN.
 */
export function isDeviceLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  return length >= 1 && length <= LABEL_MAX && !LABEL_FORBIDDEN.test(value)
}

const sha256 = (text: string): Buffer => crypto.createHash('sha256').update(text, 'utf8').digest()

/**
 * A typed code, the Crockford way: case, spaces and dashes ignored, `I` and `L` read as `1` and
 * `O` as `0`. Null unless the result is 10 letters of the alphabet. Only ASCII is read, so no
 * Unicode case mapping (a dotless i, a long s) can turn into a letter of the code.
 */
export function normaliseCode(text: string): string | null {
  if (!CODE_TYPED.test(text)) return null
  const plain = text.replace(/[ -]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0')
  return CODE_PATTERN.test(plain) ? plain : null
}

/** Compares a sent owner token with the viewer's, as SHA-256 digests by timingSafeEqual. */
function ownerTokenMatches(sent: string | undefined, token: string): boolean {
  return typeof sent === 'string' && crypto.timingSafeEqual(sha256(sent), sha256(token))
}

/** Every value of one header as received, from the raw header lines (Node joins or drops repeats). */
function rawHeader(incoming: IncomingMessage | undefined, name: string): string[] {
  const raw = incoming?.rawHeaders ?? []
  const values: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!)
  return values
}

/** The body, at most BODY_MAX bytes, decoded as strict UTF-8; null when larger or not UTF-8. Never reads past the limit. */
async function readBody(request: Request, incoming: IncomingMessage | undefined): Promise<string | null> {
  const lengths = rawHeader(incoming, 'content-length')
  if (lengths.length > 1 || (lengths.length === 1 && !(/^\d{1,6}$/.test(lengths[0]!) && Number(lengths[0]) <= BODY_MAX))) return null
  const chunks: Uint8Array[] = []
  let total = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > BODY_MAX) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    return null
  }
}

/**
 * `{ code, label }` and nothing else, both strings, the label by isDeviceLabel. `code` is null when
 * it does not normalise: that still counts as a wrong try.
 */
function parseRequest(text: string): { code: string | null; label: string } | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).sort().join(',') !== 'code,label') return null
  const { code, label } = doc
  if (typeof code !== 'string' || !isDeviceLabel(label)) return null
  return { code: normaliseCode(code), label }
}

export type PairingRead<S> = { ok: true; setting: S; doc: Record<string, unknown> } | { ok: false }

/** A new code as the code route answers it. `codeId` names the code and nothing else: random, not derived from it. */
export interface MadeCode {
  code: string
  codeId: string
  expiresAt: string
}

/** A device paired since this viewer started, and the identity of the code that paired it. */
export interface PairedDevice {
  device: string
  codeId: string
}

export interface Pairing {
  /** A new code, voiding any older one: `{ code: "7K3QX-9M2PD", codeId, expiresAt }`. */
  makeCode(): MadeCode
  /** Voids the code (the entry turned off, or remote.json changed). */
  voidCode(): void
  codePending(): boolean
  /** The devices paired since this viewer started, each with the code that paired it, the last 16. */
  paired(): PairedDevice[]
  /** POST /api/remote/pair, behind the gate's steps 1 to 6. */
  handler: Handler
}

/**
 * The pairing state of one remote entry: the one code (only its SHA-256, in memory), the rate
 * limit, and the device write. `read` re-reads remote.json under the lock and gives the checked
 * setting and the parsed document from the same bytes; `stillOn` says whether that setting is still
 * on for this viewer and for the request that passed the gate. `refused` counts each refusal.
 */
export function createPairing<S>(opts: {
  file: string
  maxBytes: number
  now: () => number
  read: (file: string) => PairingRead<S>
  stillOn: (setting: S, incoming: IncomingMessage | undefined) => boolean
  refused: () => void
}): Pairing {
  const lock = createLockedFile(opts.file, fsPromises)
  let code: { digest: Buffer; madeAt: number; wrong: number; id: string } | null = null
  const admitted: number[] = []
  const paired: PairedDevice[] = []

  /** The pending code, or null; an expired one is voided here. A clock that went back reads as expired. */
  function live(): typeof code {
    if (code) {
      const age = opts.now() - code.madeAt
      if (!(age >= 0 && age < CODE_TTL_MS)) code = null
    }
    return code
  }

  /** One request in the sliding minute, or false when ten were already let through. */
  function admit(): boolean {
    const now = opts.now()
    while (admitted.length > 0 && !(now - admitted[0]! < PAIR_WINDOW_MS && now >= admitted[0]!)) admitted.shift()
    if (admitted.length >= PAIR_LIMIT) return false
    admitted.push(now)
    return true
  }

  /** Adds the device under the lock, to the file as it is now; the id, or null when the file may not be written. */
  async function addDevice(label: string, secretSha256: string, incoming: IncomingMessage | undefined): Promise<string | null> {
    return lock.mutate(async () => {
      const current = opts.read(opts.file)
      if (!current.ok || !opts.stillOn(current.setting, incoming)) return null
      const listed = current.doc['devices'] === undefined ? [] : current.doc['devices']
      if (!Array.isArray(listed) || listed.length >= MAX_DEVICES) return null
      const taken = new Set(listed.map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['id'] : undefined)))
      let id: string
      do id = crypto.randomBytes(8).toString('hex')
      while (taken.has(id))
      // every other field, at the top level and in each device, is written back as it was read
      current.doc['devices'] = [...listed, { id, label, secretSha256, pairedAt: new Date(opts.now()).toISOString() }]
      // never a file the reader would refuse for its size, which would turn the entry off
      if (Buffer.byteLength(`${JSON.stringify(current.doc, null, 2)}\n`) > opts.maxBytes) return null
      await lock.atomicWrite(current.doc)
      return id
    })
  }

  async function handle(c: Context, incoming: IncomingMessage | undefined): Promise<Response> {
    const refuse = () => {
      opts.refused()
      return c.text('Forbidden', 403)
    }
    // one counter for the route: every request arrives from Serve on loopback
    if (!admit()) return refuse()
    const types = rawHeader(incoming, 'content-type')
    if (types.length !== 1 || types[0]!.toLowerCase() !== 'application/json') return refuse()
    const text = await readBody(c.req.raw, incoming)
    const request = text === null ? null : parseRequest(text)
    if (!request) return refuse()

    // From here to the void there is no await, so two requests cannot both match.
    const pending = live()
    if (!pending) return refuse()
    const matched = request.code !== null && crypto.timingSafeEqual(sha256(request.code), pending.digest)
    if (!matched) {
      pending.wrong += 1
      if (pending.wrong >= CODE_TRIES) code = null
      return refuse()
    }
    // void FIRST: whatever happens to the write, this code never pairs again
    code = null
    const codeId = pending.id

    const secret = crypto.randomBytes(32).toString('base64url')
    let id: string | null
    try {
      id = await addDevice(request.label, crypto.createHash('sha256').update(secret, 'ascii').digest('hex'), incoming)
    } catch (error) {
      const name = (error as NodeJS.ErrnoException | undefined)?.code
      console.error(`agent-inbox remote entry: pairing could not write remote.json (${typeof name === 'string' && /^[A-Z0-9_]{1,32}$/.test(name) ? name : 'error'})`)
      id = null
    }
    if (id === null) return refuse()
    paired.push({ device: id, codeId })
    if (paired.length > PAIRED_SHOWN) paired.splice(0, paired.length - PAIRED_SHOWN)
    // the secret exists in this one response and nowhere else
    return c.json({ ok: true, device: id, secret }, 200)
  }

  return {
    makeCode() {
      const plain = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(32)]!).join('')
      const madeAt = opts.now()
      const codeId = crypto.randomBytes(8).toString('hex')
      code = { digest: sha256(plain), madeAt, wrong: 0, id: codeId }
      return { code: `${plain.slice(0, 5)}-${plain.slice(5)}`, codeId, expiresAt: new Date(madeAt + CODE_TTL_MS).toISOString() }
    },
    voidCode() {
      code = null
    },
    codePending: () => live() !== null,
    paired: () => paired.map((entry) => ({ ...entry })),
    handler: async (c) => {
      const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming
      try {
        return await handle(c, incoming)
      } catch {
        // a body that broke off, or anything else: the same bare refusal
        opts.refused()
        return c.text('Forbidden', 403)
      }
    },
  }
}

/**
 * POST /api/remote-entry/code, for the loopback app only, and only when the viewer was started with
 * an owner token: `X-Agent-Inbox-Owner` must equal it, else 403. The token keeps the route from
 * existing on a viewer the desktop app did not start; it does not limit who on the hub can make a
 * code, because any local process can read it from GET /api/owner (the loopback viewer's own trust).
 * So the answer carries `codeId`, which only the caller learns: the app tells its own code's pairing
 * from another's by it. The loopback entry's own rules apply first, so the request also needs the
 * loopback `Origin`. 409 `{ error: "remote_entry_off" }` while the remote entry is not on and
 * listening, so no code is made for a listener that is not there.
 */
export function remoteCodeRoute(entry: { makeCode(): MadeCode | null }, ownerToken: string): Handler {
  return (c) => {
    if (!ownerTokenMatches(c.req.header('x-agent-inbox-owner'), ownerToken)) return c.text('Forbidden', 403)
    const made = entry.makeCode()
    if (!made) return c.json({ error: 'remote_entry_off' }, 409, { 'Cache-Control': 'no-store' })
    return c.json(made, 200, { 'Cache-Control': 'no-store' })
  }
}
