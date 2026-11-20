// Types for public/hub-files.js (#634): a card's file opened as a copy on the Mac that shows another Mac's Inbox.

/** The hub view's file members of `agentInboxDesk` (electron/remote-preload.cjs). */
export interface HubFilesBridge {
  filesAvailable(): Promise<unknown>
  openFile(request: { kind: 'item' | 'row'; id: string; path: string }): Promise<unknown>
  onConnection?(callback: (value: unknown) => void): () => void
}

/** The hub's document extensions (src/remote-file.ts), lowercase with the dot. */
export const HUB_FILE_EXTENSIONS: readonly string[]
/** The hub's allowed roots besides `~/` (src/remote-file.ts ALLOWED_ROOTS). */
export const HUB_FILE_ROOTS: readonly string[]
export const OPEN_COPY: 'Open a copy on this Mac'
export const ONLY_THERE: string
/** One sentence per refusal word main can answer. */
export const HUB_FILE_REFUSALS: Readonly<Record<string, string>>
export const HUB_FILE_FALLBACK: string
/** The sentence for a refusal word, HUB_FILE_FALLBACK for any other. */
export function hubFileRefusal(reason: unknown): string
/** Whether a path may open as a copy: the hub's rule (`~/` or an allowed root, a listed extension, nothing hidden). */
export function hubFileListed(path: unknown): boolean
/** `{ kind, id }` for an item or a plan row, else null. */
export function hubFileEntity(entity: unknown): { kind: 'item' | 'row'; id: string } | null
/** The attributes (escaped markup) and the title a file link carries when a click opens its copy, or null (an unlisted path, no owner). */
export function hubFileLinkAttrs(path: unknown, entity: unknown): { attrs: string; title: string } | null
/**
 * A file chip's group in another Mac's Inbox: the chip and Copy path; a listed file's chip opens its copy on a click,
 * any other file's group is followed by the line saying it opens only there.
 */
export function hubFileGroupHtml(parts: {
  chip: (attrs?: string, title?: string | null) => string
  copy: string
  link: { path: string; label: string }
  entity: { kind: string; id: string }
}): string

export interface HubFileRequest { kind: 'item' | 'row'; id: string; path: string }

export interface HubFiles {
  /** Whether a card's files open here as copies (the last `filesAvailable()` answer). */
  available(): boolean
  /** Resolves once the last ask has its answer. */
  ready(): Promise<void>
  /** The request a file link opens with a click (it carries an entity and a listed, absolute path), or null while files do not open here. */
  request(el: HTMLElement | null): HubFileRequest | null
  /** One open: `{ ok: true }`, or `{ ok: false, message }` with the sentence to say. Never throws. */
  open(request: HubFileRequest): Promise<{ ok: true } | { ok: false; message: string }>
}

export function installHubFiles(opts?: {
  desk?: () => HubFilesBridge | null | undefined
  onChange?: () => void
}): HubFiles
