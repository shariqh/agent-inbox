// The card signature verifier (#536; publishable-agent design §3.10, D21): A2A v1.0.1 §8.4's JWS
// over the RFC 8785 (JCS) form of the card without `signatures`, raw, with no normalisation and
// no precondition, so a card signed over any other payload fails closed. ES256 over P-256 only
// (the algorithm our signer uses); every other `alg`, `none` and `HS*` included, fails. The key
// is found by `kid`, an RFC 7638 thumbprint, in the profile extension's `keys`: a header `jwk`,
// `jku` or `x5u` is never read or fetched. Depth, size, count and header size are capped before
// anything is canonicalised or parsed. Node core and the card rule only: meshctl's add and check
// import it, never the viewer or the stdio MCP server. The signer is packages/mesh's
// card-signing.ts; signatures are checked at add, accept and move, never on every call.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { checkProfile, signedPayload } from './agent-card.js'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

const PROFILE_URI = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
const DEPTH_MAX = 32
const CARD_MAX = 64 * 1024
const SIGNATURES_MAX = 4
const HEADER_MAX = 2048
const B64URL = /^[A-Za-z0-9_-]+$/
/** An RFC 7638 SHA-256 thumbprint: 43 base64url characters. */
export const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/

/** RFC 7638: SHA-256 of the key's required members in lexicographic order, as base64url. */
export function jwkThumbprint(key: Json): string {
  const members = key.kty === 'OKP' ? { crv: key.crv, kty: key.kty, x: key.x } : { crv: key.crv, kty: key.kty, x: key.x, y: key.y }
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url')
}

/** Containers nested inside one another past 32 levels, counted without recursion and stopping at the cap. */
export function tooDeep(card: unknown): boolean {
  const stack: Array<[unknown, number]> = [[card, 1]]
  while (stack.length) {
    const [v, depth] = stack.pop()!
    if (!v || typeof v !== 'object') continue
    if (depth > DEPTH_MAX) return true
    for (const x of Array.isArray(v) ? v : Object.values(v as Json)) stack.push([x, depth + 1])
  }
  return false
}

/** Why the card is not canonical-stable (§3.10), or undefined: "", [], {} or null anywhere, or "required": false on an extension. */
export function unstableReason(card: unknown): 'null-value' | 'empty-value' | 'required-false' | undefined {
  const stack: unknown[] = [card]
  while (stack.length) {
    const v = stack.pop()
    if (v === null) return 'null-value'
    if (v === '') return 'empty-value'
    if (typeof v !== 'object') continue
    const values = Array.isArray(v) ? v : Object.values(v as Json)
    if (!values.length) return 'empty-value'
    stack.push(...values)
  }
  const extensions = obj(obj(card).capabilities).extensions
  return Array.isArray(extensions) && extensions.some((e) => obj(e).required === false) ? 'required-false' : undefined
}

/** Why one signature by a listed key fails: a refused header, an algorithm other than ES256 over a P-256 key, or no match. */
export type SignatureFailure = 'header' | 'alg' | 'mismatch'
export type Signatures = {
  /** the thumbprints of the keys the card's (valid) profile lists */
  keys: string[]
  /** the `kid` of each signature by a listed key that verified */
  valid: string[]
  failed: SignatureFailure[]
  /** signatures whose `kid` names no listed key */
  unlisted: number
  /** the card is not canonical-stable, so a failure may be a signer that signed another payload */
  unstable: boolean
}
export type SignaturesRefused = 'too-deep' | 'too-large' | 'unreadable'

/**
 * Every signature on `card`, checked against the keys its profile extension lists, or why the
 * card's signatures cannot be read at all: nested past 32, over 64 KiB, `signatures` not a list
 * of at most 4 `{ protected, signature }` entries, or a protected header over 2 KiB, not a JSON
 * object or without a string `kid`. The caps come first, so nothing unbounded is canonicalised.
 */
export function verifyCardSignatures(card: unknown): Signatures | { refused: SignaturesRefused } {
  if (tooDeep(card)) return { refused: 'too-deep' }
  if (Buffer.byteLength(JSON.stringify(card) ?? '') > CARD_MAX) return { refused: 'too-large' }
  const c = obj(card)
  const entries = c.signatures === undefined ? [] : c.signatures
  if (!Array.isArray(entries) || entries.length > SIGNATURES_MAX) return { refused: 'unreadable' }
  const signatures: Array<{ header: Json; protected: string; signature: string }> = []
  for (const entry of entries) {
    const e = obj(entry)
    if (typeof e.protected !== 'string' || typeof e.signature !== 'string' || !B64URL.test(e.protected) || !B64URL.test(e.signature)) return { refused: 'unreadable' }
    if (e.protected.length > Math.ceil(HEADER_MAX * 4 / 3)) return { refused: 'unreadable' }
    let header: unknown
    try {
      header = JSON.parse(Buffer.from(e.protected, 'base64url').toString('utf8'))
    } catch { /* below */ }
    if (!header || typeof header !== 'object' || Array.isArray(header) || typeof (header as Json).kid !== 'string') return { refused: 'unreadable' }
    signatures.push({ header: header as Json, protected: e.protected, signature: e.signature })
  }
  // keys only from a profile that passed checkProfile: public JWKs of a known curve, none twice
  const profile = checkProfile(c)
  const extensions = obj(c.capabilities).extensions
  const params = profile && 'profile' in profile && Array.isArray(extensions) ? obj(extensions.map(obj).find((x) => x.uri === PROFILE_URI)?.params) : {}
  const listed = Array.isArray(params.keys) ? params.keys.map(obj) : []
  const keys = new Map(listed.map((k) => [jwkThumbprint(k), k]))
  const result: Signatures = { keys: [...keys.keys()], valid: [], failed: [], unlisted: 0, unstable: unstableReason(c) !== undefined }
  if (!signatures.length) return result
  const payload = Buffer.from(signedPayload(c)).toString('base64url')
  for (const { header, protected: head, signature } of signatures) {
    const kid = header.kid as string
    const key = keys.get(kid)
    if (!key) { result.unlisted++; continue }
    if (['crit', 'b64', 'x5c'].some((m) => Object.hasOwn(header, m)) || typeof header.typ !== 'string' || header.typ.toUpperCase() !== 'JOSE') { result.failed.push('header'); continue }
    if (header.alg !== 'ES256' || key.kty !== 'EC' || key.crv !== 'P-256') { result.failed.push('alg'); continue }
    const bytes = Buffer.from(signature, 'base64url')
    let ok = false
    try {
      ok = bytes.length === 64 && verify('sha256', Buffer.from(`${head}.${payload}`), { key: createPublicKey({ key: key as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, bytes)
    } catch { /* a key Node cannot import verifies nothing */ }
    if (ok) result.valid.push(kid)
    else result.failed.push('mismatch')
  }
  return result
}

const HINT = ': the card has empty or default values, which A2A signers drop, so its signer may have signed a different payload'

/**
 * What `add` makes of a card's signatures (§3.10): signed by the listed keys whose signatures
 * verified, unsigned (no signature, or none naming a listed key, which counts as unsigned), or
 * refused with fixed words: unreadable signatures, or one by a listed key that fails. `keys` are
 * the thumbprints of every key the card lists, which `add` pins in the entry.
 */
export type SignatureVerdict = { keys: string[] } & ({ signed: string[] } | { unsigned: 'absent' | 'unlisted' } | { refused: string })

export function signatureVerdict(card: unknown): SignatureVerdict {
  const s = verifyCardSignatures(card)
  if ('refused' in s) {
    const words = { 'too-deep': 'the card is nested more than 32 deep', 'too-large': 'the card is over 64 KiB', unreadable: 'the card has signatures meshctl cannot read' }
    return { keys: [], refused: words[s.refused] }
  }
  const failed = s.failed[0]
  if (failed === 'header') return { keys: s.keys, refused: 'the card has a signature whose header meshctl refuses (crit, b64 or x5c, or a typ other than JOSE)' }
  if (failed === 'alg') return { keys: s.keys, refused: 'the card has a signature by a listed key that is not ES256 over a P-256 key, the one algorithm meshctl verifies' }
  if (failed === 'mismatch') return { keys: s.keys, refused: `the card has a signature by a listed key that does not verify${s.unstable ? HINT : ''}` }
  if (s.valid.length) return { keys: s.keys, signed: s.valid }
  return { keys: s.keys, unsigned: s.unlisted ? 'unlisted' : 'absent' }
}
