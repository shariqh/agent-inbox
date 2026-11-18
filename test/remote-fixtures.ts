// test/remote-fixtures.ts — shared by the remote entry's tests (#617, PR 2a).
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// Every value here is synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.
// Requests go over a raw TCP socket, so a test controls the request target and every
// header line byte for byte (a duplicated header, a backslash, `%61`), which
// `http.request` would check or rewrite.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'

export const HOST = 'hub.example.ts.net'
export const LOGIN = 'owner@example.com'
export const ORIGIN = `https://${HOST}`
export const VIEWER_PORT = 4319

/** A device secret as pairing (PR 2b) hands it out: 32 random bytes as 43 base64url characters. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** What remote.json stores for a secret: the SHA-256 of its 43 ASCII characters, as lowercase hex. */
export function secretSha256(secret: string): string {
  return createHash('sha256').update(secret, 'ascii').digest('hex')
}

export function device(secret: string, id = '3f9c0a1b2d4e5f60', label = 'laptop') {
  return { id, label, secretSha256: secretSha256(secret), pairedAt: '2026-11-20T09:00:00.000Z' }
}

export function setting(port: number, devices: unknown[], extra: Record<string, unknown> = {}) {
  return { schema: 1, enabled: true, viewerPort: VIEWER_PORT, port, host: HOST, logins: [LOGIN], devices, ...extra }
}

/** Write remote.json into `dir` as main will (mode 0600 by default). */
export function writeSetting(dir: string, value: unknown, mode = 0o600): string {
  const file = join(dir, 'remote.json')
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  chmodSync(file, mode)
  return file
}

/** A port nothing listens on right now (the OS picks it, then it is released). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * One HTTP/1.1 request written byte for byte. `headers` is a list, so a name may
 * repeat; no Host is added unless given.
 */
export function rawRequest(
  port: number,
  { method = 'GET', target, headers = [], body }: { method?: string; target: string; headers?: Array<[string, string]>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${target} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`), 'Connection: close']
    if (body !== undefined) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`)
    const socket = connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const split = text.indexOf('\r\n\r\n')
      const head = split === -1 ? text : text.slice(0, split)
      const [statusLine = '', ...headerLines] = head.split('\r\n')
      const parsed: Record<string, string> = {}
      for (const line of headerLines) {
        const colon = line.indexOf(':')
        if (colon > 0) parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      let rest = split === -1 ? '' : text.slice(split + 4)
      if (parsed['transfer-encoding'] === 'chunked') rest = dechunk(rest)
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), headers: parsed, body: rest })
    })
    socket.write(`${lines.join('\r\n')}\r\n\r\n${body ?? ''}`)
  })
}

function dechunk(text: string): string {
  let out = ''
  let rest = text
  for (;;) {
    const line = rest.indexOf('\r\n')
    if (line === -1) return out
    const size = parseInt(rest.slice(0, line), 16)
    if (!size) return out
    out += rest.slice(line + 2, line + 2 + size)
    rest = rest.slice(line + 2 + size + 2)
  }
}

/** The headers a paired device's request carries through Serve. */
export function deviceHeaders(secret: string, extra: Array<[string, string]> = []): Array<[string, string]> {
  return [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', secret], ...extra]
}
