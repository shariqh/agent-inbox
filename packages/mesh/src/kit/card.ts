// The card helpers (publishable-agent design §3, §8; docs/ext/profile-v1.md): `meshCard` builds
// a card `meshctl check --strict` accepts at the publishable level — provider, version, an A2A 1.0
// JSON-RPC interface, the bearer requirement naming the role "call", and the profile extension
// with the stable id, the signing keys' public halves and each skill's egress and residency —
// with no empty or default value, so every A2A signer signs the same bytes. `servedCard` loads
// nothing: give it the keys `loadSigningKeys` read at start, and it signs once with each.
import { PROFILE, publicJwk, signCard } from '../card-signing.js'
import type { SigningKey } from '../card-signing.js'

type Json = Record<string, unknown>

export { PROFILE }

/** What a skill contacts while it works (§3.8): a kind of service, which hosts, and what it sends there. */
export type Egress = { purpose: 'model' | 'search' | 'storage' | 'web' | 'api' | 'agent'; hosts: 'operator' | 'any' | string[]; sends: 'input' | 'metadata' }
export type Skill = {
  id: string; name: string; description: string; tags: string[]
  /** `"none"` when the skill contacts nothing. */
  egress: Egress[] | 'none'
  /** Where a router may place the work (§3.9). */
  residency: 'caller-host' | 'caller-mesh' | 'any'
}
export type CardSpec = {
  name: string; description: string
  /** SemVer 2.0. */
  version: string
  provider: { organization: string; url: string }
  /** `<domain>[/<path>]/<name>`: the publisher's stable id for this agent (§3.4). */
  id: string
  streaming: boolean
  /** The agent's own extensions, before the profile; never `required: false`. */
  extensions?: Json[]
  inputModes: string[]
  outputModes: string[]
  skills: Skill[]
}

/** The card served at `url`, listing `keys` (public JWKs) in the profile; none for an unsigned card. */
export const meshCard = (spec: CardSpec, url: string, keys: Json[] = []): Json => ({
  name: spec.name, description: spec.description, version: spec.version,
  provider: { organization: spec.provider.organization, url: spec.provider.url },
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {
    streaming: spec.streaming, pushNotifications: false,
    extensions: [
      ...(spec.extensions ?? []),
      {
        uri: PROFILE, description: 'Stable id, signing keys, and per-skill egress and residency',
        params: {
          id: spec.id, ...(keys.length ? { keys } : {}),
          skills: Object.fromEntries(spec.skills.map((s) => [s.id, { egress: s.egress, residency: s.residency }])),
        },
      },
    ],
  },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: { list: ['call'] } } }],
  defaultInputModes: spec.inputModes, defaultOutputModes: spec.outputModes,
  skills: spec.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
})

/** `build`'s card signed by every key, listing their public halves; unsigned, with no keys, when there is none. */
export const servedCard = (build: (keys: Json[]) => Json, keys: SigningKey[]): Json =>
  keys.length ? signCard(build(keys.map(publicJwk)), keys) : build([])
