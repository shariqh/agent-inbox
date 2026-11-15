export type ChatTool = 'claude' | 'copilot'
export type ChatHiddenReason = 'temp' | 'non-interactive' | 'empty' | 'folder-gone'

export interface Chat {
  id: string
  /** 'claude' or 'copilot' from the index; any other string is kept, labelled raw and never resumed */
  tool: string
  title: string | null
  titleAuto: boolean
  project: string
  cwd: string | null
  branch: string | null
  createdAt: string | null
  lastActiveAt: string | null
  live: boolean
  pr: { number: number; repo: string; url: string } | null
  hidden: string[]
}

export interface ChatCounts { total: number; hidden: number; claude: number; copilot: number; live: number }

export interface ChatsBody {
  chats: Chat[]
  counts: ChatCounts
  truncated: boolean
  claudeDays: number
}

export interface ChatFilter { query: string; tool: 'all' | ChatTool; project: string | null }

export const CHATS_HASH: '#chats'
export function isChatsHash(hash: unknown): boolean
export function chatsUrl(all: boolean): string
export function readChatsBody(body: unknown): ChatsBody | null
export function sortChats(chats: readonly Chat[]): Chat[]
export function inferHome(chats: readonly Pick<Chat, 'cwd'>[]): string | null
export function displayFolder(cwd: string | null, home: string | null): string
export function filterChats(chats: readonly Chat[], filter: ChatFilter, home: string | null): Chat[]
export function projectOptions(chats: readonly Pick<Chat, 'project'>[]): string[]
export function resumeCommand(chat: { id: unknown; tool: unknown; cwd: unknown }): string | null
export function resumeControl(chat: Chat): { command: string | null; title: string }
export function toolLabel(tool: string): string
export function hiddenLabel(reason: string): string
export function titleView(chat: Pick<Chat, 'title' | 'titleAuto'>): { text: string; quiet: boolean; title: string | null }
export function lastActiveView(iso: string | null, nowMs: number): { text: string; title: string }
export function shownText(shown: number, loaded: number): string
export function allSwitchText(counts: ChatCounts | null): string
export function emptyText(input: { loaded: number; shown: number; hidden: number; all: boolean }): string | null
export function retentionText(claudeDays: number): string
export const TRUNCATED_TEXT: string
export function shouldFetchOnOpen(input: { loadedAt: number | null; loading: boolean; nowMs: number }): boolean
