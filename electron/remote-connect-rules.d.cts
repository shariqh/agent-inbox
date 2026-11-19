// Type declarations for electron/remote-connect-rules.cjs (#617, PR 3a): the pure rules of connect
// mode, split from electron/remote-connect.cjs for size only. Runtime lives in the .cjs;
// electron/remote-connect.d.cts declares the public part, which remote-connect.cjs re-exports.
export {
  certificateFailure, deviceLabelFor, hubHref, hubLabelFor, inTailnet, isDeviceLabel, normaliseCode, parseHubOrigin, parsePeers, suffixFrom,
} from './remote-connect.cjs'

export const BLOB: RegExp
export const BLOB_MAX: number
/** #617 PR 4b: the longest Open desk command template, in UTF-16 code units */
export const DESK_COMMAND_MAX: 512
export const DEVICE_ID: RegExp
export const HUB_ID: RegExp
export const MAX_HUBS: number
export const NODE_ID: RegExp
export const PLACE: RegExp
export const SECRET: RegExp

export interface StoredHub {
  id: string; origin: string; label: string; node: string; machine: string | null; device: string; secret: string
  /** #617 PR 4b: the Open desk command template when one is stored and valid, else null */
  deskCommand: string | null
}
/**
 * #617 PR 4b: one line of 1 to 512 characters, no control character, `{desk}` or `{attach}` at least
 * once, and no other `{` or `}`.
 */
export function validDeskCommand(text: unknown): text is string
/** The active hub of a schema-1 document, null for none, false when any part fails its rule. */
export function activeOf(doc: Record<string, unknown>): StoredHub | null | false
export function validEntry(entry: unknown): boolean
export function writeBase(read: unknown, replace: boolean): { refuse: 'newer_schema' | 'bad_file' | 'hub_exists' } | { base: Record<string, unknown> }
export function keychainReady(safeStorage: unknown, platform: string): boolean
export function marked(response: Response): boolean
export function isRedirect(response: Response): boolean
export function discard(response: Response): Promise<void>
export function readJson(response: Response, max: number): Promise<unknown>
export function versionText(value: unknown): value is string
