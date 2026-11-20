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
/** A file chip's group in another Mac's Inbox: the chip, Copy path, and Open a copy or the line saying it opens only there. */
export function hubFileGroupHtml(parts: { chip: string; copy: string; link: { path: string; label: string }; entity: { kind: string; id: string } }): string

export interface HubFiles {
  /** Whether a card's files open here as copies (the last `filesAvailable()` answer). */
  available(): boolean
  /** Resolves once the last ask has its answer. */
  ready(): Promise<void>
  /** One open: `button` is disabled while it runs; `note` says a refusal. Main's answer, or null. */
  run(request: { kind: string; id: string; path: string }, button: HTMLButtonElement | null, note: HTMLElement | null): Promise<unknown>
}

export function installHubFiles(opts?: {
  desk?: () => HubFilesBridge | null | undefined
  onChange?: () => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  documentRef?: Document
}): HubFiles
