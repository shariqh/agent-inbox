// Card-signing helpers for the tests (#536): a P-256 test key and a raw JWS signer over the card's
// JCS form without `signatures`, with any protected header, so a test can sign what our signer
// (packages/mesh/src/card-signing.ts) refuses to: an unstable card, an unlisted key, `alg: none`,
// or a P-384 or Ed25519 key.
// Deliberately NOT named *.test.ts: it is imported, never collected.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

type Json = Record<string, any>
export type TestKey = { key: KeyObject; publicJwk: Json; privateJwk: Json; kid: string }

/** A fresh P-256 key, its public JWK as a card lists it, and its RFC 7638 thumbprint. */
export function testKey(): TestKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' }) as Json
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  const kid = createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest('base64url')
  return { key: privateKey, publicJwk, privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, kid }
}

const jcs = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs((v as Json)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** One signature entry over `payload` (default: the card's raw JCS without `signatures`). */
export function jws(card: Json, key: KeyObject, header: Json, payload?: string): Json {
  const { signatures: _drop, ...rest } = card
  const head = Buffer.from(JSON.stringify(header)).toString('base64url')
  const body = Buffer.from(payload ?? jcs(rest)).toString('base64url')
  // the digest the key type needs (ES384: SHA-384, Ed25519: none), whatever `alg` the header claims
  const digest = key.asymmetricKeyType === 'ed25519' ? null : key.asymmetricKeyDetails?.namedCurve === 'secp384r1' ? 'sha384' : 'sha256'
  return { protected: head, signature: sign(digest, Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
}

/** `card` with `signatures` set to one ES256 signature by each key (the header our signer writes). */
export const signWith = (card: Json, ...keys: TestKey[]): Json =>
  ({ ...card, signatures: keys.map((k) => jws(card, k.key, { alg: 'ES256', typ: 'JOSE', kid: k.kid })) })
