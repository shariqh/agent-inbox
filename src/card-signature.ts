// The card signature verifier (#536; publishable-agent design §3.10, D21): A2A v1.0.1 §8.4's JWS
// over the RFC 8785 (JCS) form of the card without `signatures`, raw, with no normalisation and
// no precondition, so a card signed over any other payload fails closed. ES256, ES384 and EdDSA
// only; the key is found by `kid`, an RFC 7638 thumbprint, in the profile extension's `keys`
// (a header `jwk`, `jku` or `x5u` is never read or fetched). Size and depth are capped before
// anything is canonicalised. Node core and the card rule only: meshctl's add and check import it,
// never the viewer or the stdio MCP server. packages/mesh holds the signer (card-signing.ts).
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
// alg → [the key's curve, the digest Node core verifies with, the signature's length in bytes]
const ALGS: Record<string, [string, string | null, number]> = { ES256: ['P-256', 'sha256', 64], ES384: ['P-384', 'sha384', 96], EdDSA: ['Ed25519', null, 64] }

/** RFC 7638: SHA-256 of the key's required members in lexicographic order, as base64url. */
export function jwkThumbprint(key: Json): string {
  const members = key.kty === 'OKP' ? { crv: key.crv, kty: key.kty, x: key.x } : { crv: key.crv, kty: key.kty, x: key.x, y: key.y }
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url')
}

/** Containers nested inside one another, counted without recursion and stopping past 32 levels. */
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

/** Why one signature by a listed key fails: a refused header member, an algorithm off the list or not the key's, or no match. */
export type SignatureFailure = 'header' | 'alg' | 'mismatch'
export type Signatures = {
  /** the thumbprints of the profile's keys */
  keys: string[]
  /** each signature by a listed key that verified */
  valid: Array<{ kid: string; alg: string }>
  failed: SignatureFailure[]
  /** signatures whose `kid` names no listed key */
  unlisted: number
  /** the card is not canonical-stable: a failure may be a signer that signed another payload */
  unstable: boolean
}
export type SignaturesRefused = 'too-deep' | 'too-large' | 'malformed' | 'too-many' | 'header-too-large'

/**
 * Every signature on `card`, checked against the keys its profile extension lists, or why the
 * card's signatures cannot be read at all. Depth, size, count and header size are checked first,
 * so nothing unbounded is canonicalised or parsed.
 */
export function verifyCardSignatures(card: unknown): Signatures | { refused: SignaturesRefused } {
  if (tooDeep(card)) return { refused: 'too-deep' }
  if (Buffer.byteLength(JSON.stringify(card) ?? '') > CARD_MAX) return { refused: 'too-large' }
  const c = obj(card)
  const entries = c.signatures === undefined ? [] : c.signatures
  if (!Array.isArray(entries)) return { refused: 'malformed' }
  if (entries.length > SIGNATURES_MAX) return { refused: 'too-many' }
  const headers: Array<{ header: Json; protected: string; signature: string }> = []
  for (const entry of entries) {
    const e = obj(entry)
    if (typeof e.protected !== 'string' || typeof e.signature !== 'string' || !B64URL.test(e.protected) || !B64URL.test(e.signature)) return { refused: 'malformed' }
    if (e.protected.length > Math.ceil(HEADER_MAX * 4 / 3)) return { refused: 'header-too-large' }
    let header: unknown
    try {
      header = JSON.parse(Buffer.from(e.protected, 'base64url').toString('utf8'))
    } catch { /* below */ }
    if (!header || typeof header !== 'object' || Array.isArray(header) || typeof (header as Json).kid !== 'string') return { refused: 'malformed' }
    headers.push({ header: header as Json, protected: e.protected, signature: e.signature })
  }
  // keys only from a profile that passed checkProfile: public JWKs of a known curve, none twice
  const profile = checkProfile(c)
  const extensions = obj(c.capabilities).extensions
  const params = profile && 'profile' in profile && Array.isArray(extensions) ? obj(extensions.map(obj).find((x) => x.uri === PROFILE_URI)?.params) : {}
  const listed = Array.isArray(params.keys) ? params.keys.map(obj) : []
  const keys = new Map(listed.map((k) => [jwkThumbprint(k), k]))
  const result: Signatures = { keys: [...keys.keys()], valid: [], failed: [], unlisted: 0, unstable: unstableReason(c) !== undefined }
  if (!headers.length) return result
  const payload = Buffer.from(signedPayload(c)).toString('base64url')
  for (const { header, protected: head, signature } of headers) {
    const kid = header.kid as string
    const key = keys.get(kid)
    if (!key) { result.unlisted++; continue }
    if (['crit', 'b64', 'x5c'].some((m) => Object.hasOwn(header, m)) || typeof header.typ !== 'string' || header.typ.toUpperCase() !== 'JOSE') { result.failed.push('header'); continue }
    const alg = typeof header.alg === 'string' && Object.hasOwn(ALGS, header.alg) ? ALGS[header.alg]! : undefined
    if (!alg || alg[0] !== key.crv) { result.failed.push('alg'); continue }
    const bytes = Buffer.from(signature, 'base64url')
    let ok = false
    try {
      ok = bytes.length === alg[2] && verify(alg[1], Buffer.from(`${head}.${payload}`), { key: createPublicKey({ key: key as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, bytes)
    } catch { /* a key Node cannot import verifies nothing */ }
    if (ok) result.valid.push({ kid, alg: header.alg as string })
    else result.failed.push('mismatch')
  }
  return result
}
