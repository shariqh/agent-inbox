// Web search's front door (web search design §3.2): the kit's (src/kit/front-door.ts), with web
// search's request allowlist, its own identity label, `web-search/v1`, which its client proves, and
// -32602 for every refusal, an unknown method's included (its refusal fixtures record that).
// Message metadata is read under either extension URI, the Pages one or the old URN
// (publishable-agent design §6, C7), and handed to the SDK under the Pages one, holding §4.2's
// fields only. It shares no code with unslop's a2a.ts.
import { WEB_SEARCH_EXTENSION, WEB_SEARCH_EXTENSIONS } from '../a2a-client.js'
import { rebuildRequest, startFrontDoor as startKitFrontDoor } from '../kit/front-door.js'
import type { FrontDoor, FrontDoorOptions as KitOptions, RequestSpec } from '../kit/front-door.js'

export { MAX_CONNECTIONS } from '../kit/front-door.js'
export type { FrontDoor } from '../kit/front-door.js'
export const EXTENSION = WEB_SEARCH_EXTENSION

const text = (v: unknown): boolean => typeof v === 'string' && v.length >= 1 && v.length <= 253
const texts = (v: unknown, max: number): boolean => Array.isArray(v) && v.length <= max && v.every(text)
const int = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const REQUEST: RequestSpec = {
  extensions: WEB_SEARCH_EXTENSIONS,
  metadata: {
    mode: (v) => v === 'answer' || v === 'sources',
    recency: (v) => ['any', 'day', 'week', 'month', 'year'].includes(v as string),
    maxSources: (v) => int(v, 1, 10),
    sites: (v) => texts(v, 5),
    excludeSites: (v) => texts(v, 10),
    fresh: (v) => typeof v === 'boolean',
    timeoutMs: (v) => int(v, 10_000, 180_000),
  },
}

/** A new request holding only allowed fields, or undefined to refuse it. */
export const rebuild = (body: unknown): Record<string, unknown> | undefined => rebuildRequest(body, REQUEST)

export type FrontDoorOptions = Omit<KitOptions, 'request' | 'proofLabel' | 'unknownMethod'>
export const startFrontDoor = (o: FrontDoorOptions): Promise<FrontDoor> => startKitFrontDoor({ ...o, request: REQUEST, proofLabel: 'web-search/v1', unknownMethod: -32602 })
