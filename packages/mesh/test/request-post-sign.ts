// Signs request-post's fixture card (publishable-agent design §8, C8) as the private publishing
// service signs its own card: one ES256 signature over the raw JCS form of the card, by a P-256
// key made for this run and never written. The profile's `keys` becomes that key's public half and
// `signatures` its signature; every other byte of card.json stays as it is. The service's real key
// lives only with the service. `node --import ./test/ts-hooks.mjs test/request-post-sign.ts write`
// (in packages/mesh) re-signs card.json after an edit; then regenerate MANIFEST.json as the
// fixtures' README says.
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { signCard, thumbprint } from '../src/card-signing.js'

type Json = Record<string, any>
export const CARD = fileURLToPath(new URL('../../../test/fixtures/a2a-request-post/card.json', import.meta.url))
const PROFILE = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'

/** `card` listing a fresh key in its profile and signed by it alone. */
export function resign(card: Json): Json {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  const next = structuredClone(card)
  delete next.signatures
  ;(next.capabilities.extensions as Json[]).find((e) => e.uri === PROFILE)!.params.keys = [pub]
  return signCard(next, [{ kid: thumbprint(pub), key: privateKey }])
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  writeFileSync(CARD, `${JSON.stringify(resign(JSON.parse(readFileSync(CARD, 'utf8')) as Json), null, 2)}\n`)
}
