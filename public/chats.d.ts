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
export const RESUME_LABEL: 'Resume'
export const RESUME_BUSY_LABEL: string
export function resumeTerminalControl(chat: Chat, terminal: unknown): { enabled: boolean; title: string; ariaLabel: string | null }
export function resumeOutcome(result: unknown): { label: string | null; note: string | null; refresh: boolean }
export const CONTINUE_LABEL: 'Continue here…'
export const SHOW_SESSION_LABEL: 'Show session'
export const HERE_TEXT: '· here'
export const CHECKING_TEXT: string
export const SESSIONS_UNREAD_TEXT: string
/** The launch fields the Chats tab reads, as /api/launches serves them. */
export interface ChatLaunchRow { id: string; chat_id?: string | null; status?: string; end_reason?: string | null; resumable?: boolean; created_at?: string }
export function continueControl(chat: Chat): { enabled: boolean; title: string } | null
export function chatLaunch<T extends ChatLaunchRow>(launches: readonly T[] | null | undefined, chatId: string): T | null
export function drivenView(launch: ChatLaunchRow | null): {
  show: string | null; here: boolean; title: string | null; hereTitle: string | null; offTitle: string | null
}
export function continueOutcome(result: unknown): { note: string | null; refresh: boolean }
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
