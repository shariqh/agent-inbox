// Types for public/desk-open.js (#617 PR 4b): Open desk on the page shown from another Mac.

/** The hub view's Open desk members of `agentInboxDesk` (electron/remote-preload.cjs). */
export interface DeskOpenBridge {
  available(): Promise<unknown>
  open(request: { session: string }): Promise<unknown>
  onConnection?(callback: (value: unknown) => void): () => void
}

export const OPEN_DESK: 'Open desk'
/** One sentence per refusal word main can answer. */
export const DESK_REFUSALS: Readonly<Record<string, string>>
export const DESK_FALLBACK: string
/** The sentence for a refusal word, DESK_FALLBACK for any other. */
export function deskRefusal(reason: unknown): string
/** The row's session when it has a pattern-checked desk and a session id, else ''. */
export function deskSession(row: unknown): string

export interface DeskOpen {
  /** Whether Open desk is offered on this page (the last `available()` answer). */
  available(): boolean
  /** Resolves once the last ask has its answer. */
  ready(): Promise<void>
  /** One open for `session`: `button` is disabled while it runs; `note` says a refusal. Main's answer, or null. */
  run(session: string, button: HTMLButtonElement | null, note: HTMLElement | null): Promise<unknown>
  /** A card's button and sentence for `row`, or null when Open desk is not offered or the row has no desk. */
  control(doc: Document, row: unknown): HTMLElement | null
}

export function installDeskOpen(opts?: {
  desk?: () => DeskOpenBridge | null | undefined
  onChange?: () => void
  setTimeout?: (fn: () => void, ms: number) => unknown
}): DeskOpen
