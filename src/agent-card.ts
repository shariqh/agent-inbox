// The one A2A agent card rule (agent cards view design §4.4): what a card must hold for
// meshctl's unslop and request-post clients to use it. Each client keeps its own exit
// code and wording around the reason. Pure: no imports and no I/O, so the clients and
// (from V2) the viewer's cards view apply one rule.

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])

const EXPECT = {
  unslop: { skills: ['unslop'], extension: 'urn:agent-inbox:ext:unslop:v1' },
  'request-post': { skills: ['request-post', 'request-post-status'], extension: 'urn:agent-inbox:ext:request-post:v1' },
}

/**
 * Why `agent`'s client cannot use `card`, or undefined when it can: every expected skill,
 * an A2A 1.0 JSON-RPC interface, and the agent's extension with `api: 1`, checked in that
 * order. The reason is fixed words, never text from the card.
 */
export function checkCard(card: unknown, agent: keyof typeof EXPECT): string | undefined {
  const c = obj(card)
  const want = EXPECT[agent]
  const skills = list(c.skills).map((s) => s.id)
  for (const skill of want.skills) if (!skills.includes(skill)) return `no ${skill} skill`
  if (!list(c.supportedInterfaces).some((i) => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC')) return 'no A2A 1.0 JSON-RPC interface'
  const ext = list(obj(c.capabilities).extensions).find((e) => e.uri === want.extension)
  if (!ext) return `no ${want.extension} extension`
  return obj(ext.params).api === 1 ? undefined : `${agent} api is not 1`
}
