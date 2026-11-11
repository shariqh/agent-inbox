// The identity proof a loopback agent answers (docs/mesh-call.md, D17): the card request carries
// `A2A-Mesh-Challenge: <nonce>` (43 base64url characters) and the agent answers
// `A2A-Mesh-Proof: base64url(HMAC-SHA256(token, label + "\n" + nonce))`. Every agent added with
// `meshctl add` answers the one label `a2a-mesh/v1`, which `meshctl call` and `meshctl check
// --token-file` prove; a built-in agent keeps its own (`web-search/v1`) for its own client.
import { createHmac } from 'node:crypto'

export const CARD_PATH = '/.well-known/agent-card.json'
export const MESH_PROOF_LABEL = 'a2a-mesh/v1'

export const proof = (token: string, nonce: string, label: string): string =>
  createHmac('sha256', token).update(`${label}\n${nonce}`).digest('base64url')

/** The proof header for a well-formed challenge, or none: a malformed nonce is never answered. */
export const proofHeaders = (challenge: unknown, token: string, label: string): Record<string, string> =>
  typeof challenge === 'string' && /^[\w-]{43}$/.test(challenge) ? { 'a2a-mesh-proof': proof(token, challenge, label) } : {}
