// `meshctl key create|show|rotate|retire <agent>` (#536; publishable-agent design §3.10, decision
// Q6): one card-signing key per agent, a P-256 private JWK at `<mesh dir>/mesh/keys/<agent>.jwk`,
// 0600 in a 0700 folder whatever the umask, outside mesh.json. Rotation writes `<agent>-next.jwk`
// (the agent then lists both public keys and signs with both); retire makes the next key the
// agent's key and drops the old one. Like every meshctl change it is a dry run without --apply.
// A private key is never printed: `show` prints the public JWK and its RFC 7638 thumbprint, and
// refusals are fixed words, never a file's content. Each agent in packages/mesh reads only its own
// files (card-signing.ts). Node core and the verifier's thumbprint only; only meshctl imports it.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { jwkThumbprint } from './card-signature.js'

export const KEY_USAGE = `usage: agent-inbox-meshctl key create|show|rotate|retire <agent> [--apply]
create makes <mesh dir>/mesh/keys/<agent>.jwk, the agent's P-256 card-signing key (0600, in a 0700
folder); show prints its public JWK and RFC 7638 thumbprint, never the private key; rotate makes
<agent>-next.jwk, to list beside the current key and sign with both for at least 30 days; retire
then makes the next key the agent's key and drops the old one. Without --apply nothing changes.
`

export interface KeyIo {
  /** the mesh dir */
  dir: string
  /** a path as the output shows it (`~/…`) */
  show: (path: string) => string
  out: (text: string) => void
  err: (text: string) => void
}

type Json = Record<string, unknown>
// an id add would take, built-ins included; never ending in -next, which names a rotation's file
const AGENT = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const B64 = /^[A-Za-z0-9_-]{43}$/
const KEY_FILE_MAX = 4096
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants

type Key = { thumbprint: string; publicJwk: { kty: string; crv: string; x: string; y: string } }

const publicOf = (jwk: Json): Key => {
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }
  return { thumbprint: jwkThumbprint(publicJwk), publicJwk }
}

/**
 * The signing key at `path`: missing, refused with fixed words, or its public half. The file must
 * be regular (never a symlink), this user's, with no group or other bits, at most 4 KiB, and hold
 * exactly a P-256 private JWK (`kty`, `crv`, `x`, `y`, `d`) whose `d` matches its `x` and `y`.
 */
function readKeyFile(path: string): Key | 'missing' | { refused: string } {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? 'missing' : { refused: code === 'ELOOP' ? 'is a symlink' : 'cannot be read' }
  }
  let text: string
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) return { refused: 'is not a regular file you own' }
    if (stat.mode & 0o077) return { refused: 'is open to other users: chmod 600 it' }
    if (stat.size > KEY_FILE_MAX) return { refused: `is larger than ${KEY_FILE_MAX} bytes` }
    text = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  const BAD = { refused: 'does not hold one P-256 private JWK (kty, crv, x, y and d only)' }
  let jwk: Json
  try {
    jwk = JSON.parse(text) as Json
  } catch {
    return BAD
  }
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk) || Object.keys(jwk).sort().join() !== 'crv,d,kty,x,y') return BAD
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || ![jwk.x, jwk.y, jwk.d].every((v) => typeof v === 'string' && B64.test(v))) return BAD
  // `d` must belong to `x` and `y`: Node takes the public point as written, so prove it
  try {
    const probe = Buffer.from('agent-inbox key check')
    const signature = sign('sha256', probe, createPrivateKey({ key: jwk as never, format: 'jwk' }))
    if (!verify('sha256', probe, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as never, format: 'jwk' }), signature)) return BAD
  } catch {
    return BAD
  }
  return publicOf(jwk)
}

// the keys folder: absent, or a real 0700 folder this user owns (never a symlink)
function folderRefusal(path: string): string | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return undefined
  }
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return 'is not a folder you own (or is a symlink)'
  return stat.mode & 0o077 ? 'is open to other users: chmod 700 it' : undefined
}

// each missing folder down to the keys folder, made 0700 as written whatever the umask
function makeFolder(dir: string): void {
  for (const path of [dir, join(dir, 'mesh'), join(dir, 'mesh', 'keys')]) {
    try {
      lstatSync(path)
    } catch {
      mkdirSync(path, { mode: 0o700 })
      chmodSync(path, 0o700)
    }
  }
}

/** A new P-256 key, written exclusively (never over a file) at exactly 0600. */
function createKey(path: string): Key {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
  const text = `${JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d })}\n`
  const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return publicOf(jwk as Json)
}

const describe = (key: Key): string => `Thumbprint ${key.thumbprint}\nPublic JWK ${JSON.stringify(key.publicJwk)}\n`

export function runKey(args: string[], io: KeyIo): number {
  const usage = (): number => { io.err(KEY_USAGE); return 2 }
  const refuse = (reason: string): number => { io.err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const [sub, agent, ...rest] = args
  const apply = rest.length === 1 && rest[0] === '--apply'
  if (!['create', 'show', 'rotate', 'retire'].includes(sub ?? '') || agent === undefined || agent.startsWith('-') || (rest.length && !apply) || (sub === 'show' && apply)) return usage()
  if (!AGENT.test(agent) || agent.endsWith('-next')) return refuse('the agent must be 1-40 lower-case letters, digits and inner hyphens, not ending in -next')
  const keys = join(io.dir, 'mesh', 'keys')
  const current = join(keys, `${agent}.jwk`)
  const next = join(keys, `${agent}-next.jwk`)
  const folder = folderRefusal(keys)
  if (folder) return refuse(`${io.show(keys)} ${folder}`)
  const read = (path: string): Key | 'missing' | string => {
    const key = readKeyFile(path)
    return typeof key === 'object' && 'refused' in key ? `${io.show(path)} ${key.refused}` : key
  }
  const now = read(current)
  if (typeof now === 'string' && now !== 'missing') return refuse(now)
  const later = read(next)
  if (typeof later === 'string' && later !== 'missing') return refuse(later)
  const dry = (what: string): number => { io.out(`Dry run.\n${what}\nNothing changed. Re-run with --apply.\n`); return 0 }
  const NONE = `${agent} has no signing key: meshctl key create ${agent} --apply makes one`

  if (sub === 'show') {
    if (now === 'missing') return refuse(NONE)
    io.out(`Key        ${io.show(current)} (signs ${agent}'s card)\n${describe(now)}`)
    if (later !== 'missing') io.out(`Next key   ${io.show(next)} (rotation: listed beside the key above, both sign)\n${describe(later)}`)
    return 0
  }
  if (sub === 'create') {
    if (now !== 'missing') return refuse(`${agent} already has a signing key (${io.show(current)}): meshctl key rotate ${agent} replaces it`)
    if (!apply) return dry(`Would create ${io.show(current)} (0600, in a 0700 folder): a new P-256 key that signs ${agent}'s card. Its private part is never printed.`)
    makeFolder(io.dir)
    const key = createKey(current)
    io.out(`Created ${io.show(current)} (0600): ${agent}'s signing key.\n${describe(key)}List the public JWK in ${agent}'s card (its profile extension's keys); meshctl key show ${agent} prints it again.\n`)
    return 0
  }
  if (now === 'missing') return refuse(NONE)
  const THIRTY = `keep both listed for at least 30 days, then meshctl key retire ${agent} --apply`
  if (sub === 'rotate') {
    if (later !== 'missing') return refuse(`${agent} is already rotating (${io.show(next)}): ${THIRTY}`)
    if (!apply) return dry(`Would create ${io.show(next)} (0600): ${agent}'s next signing key. Then list both public keys in ${agent}'s card, sign with both, and ${THIRTY}.`)
    const key = createKey(next)
    io.out(`Created ${io.show(next)} (0600): ${agent}'s next signing key.\n${describe(key)}List it beside the current key in ${agent}'s card and sign with both (the agent signs with every key it has), then ${THIRTY}.\n`)
    return 0
  }
  // retire
  if (later === 'missing') return refuse(`${agent} has no next key to retire to: meshctl key rotate ${agent} --apply makes one`)
  const words = `key ${now.thumbprint} stops signing ${agent}'s card and ${later.thumbprint} becomes its key`
  if (!apply) return dry(`Would replace ${io.show(current)} with ${io.show(next)}: ${words}. Then drop the old public key from the card's keys.`)
  renameSync(next, current)
  io.out(`Retired: ${words}. Drop ${now.thumbprint}'s public key from ${agent}'s card.\n`)
  return 0
}
