// The card signer (#536; publishable-agent design §3.10, decision Q6): A2A v1.0.1 §8.4's JWS over
// the raw RFC 8785 (JCS) form of the card without `signatures`, ES256 in Node core, one signature
// per key with the protected header `{ alg: "ES256", typ: "JOSE", kid }`, `kid` the key's RFC 7638
// thumbprint. It refuses a card that is not canonical-stable (no "", [], {} or null anywhere and no
// `"required": false` on an extension), so raw JCS, A2A §8.4.1's rule and the A2A JS SDK all sign
// and verify the same bytes, and a key the card's profile extension does not list. Each agent
// reads only its own key files, `<mesh dir>/mesh/keys/<agent>.jwk` and, while rotating,
// `<agent>-next.jwk` (written by `meshctl key`, src/mesh-keys.ts), and signs its card once per
// start. The verifier is the root's src/card-signature.ts; the two share no code, and
// test/card-signing.test.ts holds them, and the SDK, to one another.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { signedPayload } from './a2a-client.js'
import { ConfigError, readPrivate } from './files.js'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

const PROFILE_URI = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
const AGENT = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const B64 = /^[A-Za-z0-9_-]{43}$/
const KEY_FILE_MAX = 4096

/** One signing key: its RFC 7638 thumbprint, which is the signature's `kid`, and the private key. */
export type SigningKey = { kid: string; key: KeyObject }

/** RFC 7638 for a P-256 public key: SHA-256 of `{crv, kty, x, y}` in that order, as base64url. */
export const thumbprint = (jwk: Json): string =>
  createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url')

function parseKey(text: string, path: string): SigningKey {
  const bad = new ConfigError(`${path} does not hold one P-256 private JWK (kty, crv, x, y and d only)`)
  let jwk: Json
  try {
    jwk = obj(JSON.parse(text))
  } catch {
    throw bad
  }
  if (Object.keys(jwk).sort().join() !== 'crv,d,kty,x,y' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || ![jwk.x, jwk.y, jwk.d].every((v) => typeof v === 'string' && B64.test(v))) throw bad
  // `d` must belong to `x` and `y`, the key the card lists: Node takes the public point as written
  let key: KeyObject
  try {
    key = createPrivateKey({ key: jwk as never, format: 'jwk' })
    const probe = Buffer.from('agent-inbox key check')
    if (!verify('sha256', probe, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as never, format: 'jwk' }), sign('sha256', probe, key))) throw bad
  } catch {
    throw bad
  }
  return { kid: thumbprint(jwk), key }
}

/**
 * `agent`'s signing keys, the current one first: none when it has no key file; with a next key
 * while rotating. Each file must be regular (never a symlink), this user's, 0600 and at most
 * 4 KiB, in a folder that is no symlink and open to no one else. Only `agent`'s own file names are
 * ever opened. Errors are fixed words with the path, never the content.
 */
export function loadSigningKeys(meshDir: string, agent: string): SigningKey[] {
  if (!AGENT.test(agent) || agent.endsWith('-next')) throw new ConfigError('the agent name must be 1-40 lower-case letters, digits and inner hyphens')
  const folder = join(meshDir, 'mesh', 'keys')
  let stat
  try {
    stat = lstatSync(folder)
  } catch {
    return []
  }
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077) throw new ConfigError(`${folder} must be a 0700 folder you own`)
  const keys: SigningKey[] = []
  for (const name of [`${agent}.jwk`, `${agent}-next.jwk`]) {
    const path = join(folder, name)
    const text = readPrivate(path, true, KEY_FILE_MAX)
    if (text === undefined) break
    keys.push(parseKey(text, path))
  }
  return keys
}

/** Why the card is not canonical-stable (§3.10), or undefined: the same walk as the verifier's card.stable. */
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

/**
 * `card` with `signatures` replaced by one ES256 signature per key, over the raw JCS form of the
 * card without `signatures`. Throws a ConfigError when there is no key, when the card is not
 * canonical-stable, or when its profile extension does not list every key's public half.
 */
export function signCard(card: Json, keys: SigningKey[]): Json {
  if (!keys.length) throw new ConfigError('no signing key')
  const { signatures: _old, ...unsigned } = card
  const why = unstableReason(unsigned)
  if (why) throw new ConfigError(`the card is not canonical-stable (${why}): A2A signers would sign a different payload, so it is not signed`)
  const extensions = obj(unsigned.capabilities).extensions
  const profile = Array.isArray(extensions) ? extensions.map(obj).find((e) => e.uri === PROFILE_URI) : undefined
  const listed = obj(profile?.params).keys
  const kids = Array.isArray(listed) ? listed.map((k) => thumbprint(obj(k))) : []
  for (const { kid } of keys) if (!kids.includes(kid)) throw new ConfigError(`the card's profile extension does not list signing key ${kid}`)
  const payload = Buffer.from(signedPayload(unsigned)).toString('base64url')
  const signatures = keys.map(({ kid, key }) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JOSE', kid })).toString('base64url')
    return { protected: header, signature: sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
  })
  return { ...unsigned, signatures }
}
