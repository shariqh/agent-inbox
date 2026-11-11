// The card signer (#536, publishable-agent design §3.10) against `@a2a-js/sdk` 1.3.0's signing
// helpers, both ways, on a card whose bearer requirement names the role "call": our signer's card
// verifies under the SDK's verifyAgentCardSignature (its callback looks the `kid` up in the
// profile's `keys`), and the SDK's generateAgentCardSignature verifies under meshctl's verifier
// (src/card-signature.ts, loaded at run time: it is outside this package's rootDir). With
// `"list": []` the SDK signs a different payload, so meshctl refuses it with the empty-values hint,
// and the SDK's own verifier would not notice the auth requirement removed (Appendix B).
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateAgentCardSignature, verifyAgentCardSignature } from '@a2a-js/sdk'
import type { AgentCard } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'
import { signCard, thumbprint } from '../src/card-signing.js'

type Json = Record<string, any>
type Verdict = { keys: string[]; signed?: string[]; algs?: string[]; unsigned?: string; refused?: string }
const VERIFIER = fileURLToPath(new URL('../../../src/card-signature.ts', import.meta.url))
const verdictOf = async (card: Json): Promise<Verdict> =>
  ((await import(VERIFIER)) as { signatureVerdict: (card: unknown) => Verdict }).signatureVerdict(JSON.parse(JSON.stringify(card)))

const PROFILE = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = privateKey.export({ format: 'jwk' }) as Json
const PUBLIC = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
const KID = thumbprint(PUBLIC)
const card = (list: string[]): Json => ({
  name: 'Notes search', description: 'Searches your notes.', version: '1.4.0',
  provider: { organization: 'Example Org', url: 'https://example.org' },
  supportedInterfaces: [{ url: 'http://127.0.0.1:4500/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, extensions: [{ uri: PROFILE, description: 'Stable id and keys', params: { id: 'example.org/notes-search', keys: [PUBLIC], skills: { 'search-notes': { egress: [{ purpose: 'search', hosts: 'operator', sends: 'input' }], residency: 'any' } } } }] },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: { list } } }],
  defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'search-notes', name: 'Search notes', description: 'Search your notes', tags: ['notes'] }],
})
// the SDK's callback: the key whose thumbprint is the `kid`, from the card's own list
const lookup = (c: Json) => async (kid: string) => {
  const key = (c.capabilities.extensions[0].params.keys as Json[]).find((k) => thumbprint(k) === kid)
  if (!key) throw new Error('no such key')
  return key
}
const sdkVerifies = async (c: Json): Promise<boolean> => {
  const quiet = console.debug
  console.debug = () => {}
  try {
    await verifyAgentCardSignature(lookup(c))(c as unknown as AgentCard)
    return true
  } catch {
    return false
  } finally {
    console.debug = quiet
  }
}
const sdkSign = async (c: Json): Promise<Json> =>
  JSON.parse(JSON.stringify(await generateAgentCardSignature(jwk as never, { alg: 'ES256', typ: 'JOSE', kid: KID })(c as unknown as AgentCard)))

describe('SDK interop on a card with "list": ["call"] (§3.3, §3.10)', () => {
  it('our signer → the SDK verifier', async () => {
    const signed: Json = signCard(card(['call']), [{ kid: KID, key: privateKey }])
    expect(await sdkVerifies(signed)).toBe(true)
    // the SDK's payload covers the auth declaration: changing it breaks the signature
    const tampered = structuredClone(signed)
    tampered.securityRequirements[0].schemes.bearer.list = ['admin']
    expect(await sdkVerifies(tampered)).toBe(false)
    expect(await verdictOf(signed)).toEqual({ keys: [KID], signed: [KID], algs: ['ES256'] })
  })

  it('the SDK signer → meshctl\'s verifier', async () => {
    const signed = await sdkSign(card(['call']))
    expect(await verdictOf(signed)).toEqual({ keys: [KID], signed: [KID], algs: ['ES256'] })
    const tampered = structuredClone(signed)
    delete tampered.securityRequirements
    expect(await verdictOf(tampered)).toEqual({ keys: [KID], refused: 'the card has a signature by a listed key that does not verify' })
  })

  it('with "list": [] the SDK signs another payload: meshctl refuses it with the hint, and our signer refuses the card', async () => {
    const signed = await sdkSign(card([]))
    expect(await verdictOf(signed)).toEqual({ keys: [KID], refused: 'the card has a signature by a listed key that does not verify: the card has empty or default values, which A2A signers drop, so its signer may have signed a different payload' })
    // why: the SDK's payload leaves the auth requirement out, so removing it still verifies there
    const stripped = structuredClone(signed)
    delete stripped.securityRequirements
    expect(await sdkVerifies(stripped)).toBe(true)
    expect(() => signCard(card([]), [{ kid: KID, key: privateKey }])).toThrow('not canonical-stable (empty-value)')
  })
})
