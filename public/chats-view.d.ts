import type { Chat } from './chats.js'

export interface ChatsResumeBridge {
  resumeAvailable(): Promise<unknown>
  resume(request: { tool: string; id: string }): Promise<unknown>
}

export interface ChatsDriveBridge {
  available(): Promise<boolean>
  granted(): boolean
  launches(): unknown[] | null
  launchesFailed?(): boolean
  continueChat(chat: { tool: string; id: string; title: string | null; folder: string | null },
    hooks: { returnFocus: () => HTMLElement | null; answered: (result: unknown) => void }): boolean
  showSession(launchId: string): void
}

export interface ChatsViewDeps {
  doc: Document
  fetch: (url: string) => Promise<Response>
  now: () => number
  /** the desktop app's Resume bridge, or null; the slot holds Resume exactly while one exists */
  resume?: () => ChatsResumeBridge | null
  drive?: () => ChatsDriveBridge | null
  jump?: ((session: string) => boolean | Promise<boolean>) | null
  /** the chat's row on Find, by `<tool>:<id>`, for focus hand-offs */
  rowEl?: (key: string) => HTMLElement | null
  /** a change to draw: `passive` when nobody pressed for it, `reset` for a deliberate change of what is listed */
  changed?: (change: { passive: boolean; reset: boolean }) => void
  /** a note arrived for this chat (`<tool>:<id>`): its row opens so the note is seen */
  reveal?: (key: string) => void
}

export interface ChatsView {
  opened(): void
  list(): Chat[] | null
  tool(): 'all' | 'claude' | 'copilot'
  failed(): boolean
  live(key: string): boolean
  beginPaint(): void
  paintSlot(slot: HTMLElement, key: string): void
  paintBody(body: HTMLElement, key: string, nowMs: number): void
  paintBar(root: HTMLElement, options?: { shown?: number }): void
  paintFoot(root: HTMLElement, show: boolean): void
  state(): string
}

export function installChatsView(deps: ChatsViewDeps): ChatsView
