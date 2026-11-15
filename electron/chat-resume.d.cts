// Type declarations for chat-resume.cjs (issue #586 PR 3). Runtime lives in the .cjs.
import type { TerminalCommand, TerminalId, TerminalRun } from './terminal-launch.cjs'

export type ChatTool = 'claude' | 'copilot'
export type ChatResumeReason =
  | 'unavailable' | 'invalid' | 'quitting' | 'busy' | 'index' | 'missing' | 'live' | 'opened' | 'folder' | 'write' | 'open'
export type ChatResumeResult =
  | { ok: true; terminal: TerminalId; notice?: string }
  | { ok: false; reason: ChatResumeReason; error: string }

export const CHAT_ID: RegExp
export const CHAT_TOOLS: readonly ChatTool[]
export const SCRIPT_KEEP_MS: number
export const REOPEN_MS: number
export const CHANNELS: Readonly<{ available: 'agent-inbox:chat-resume-available'; resume: 'agent-inbox:chat-resume' }>

/** The request's tool and id from a plain object, and nothing else; null unless both check. */
export function chatResumeRequest(value: unknown): { tool: ChatTool; id: string } | null
/** The script's whole text; null unless the tool, id and folder all check. */
export function chatResumeScript(chat: { tool: unknown; id: unknown; cwd: unknown }): string | null
export function scriptName(tool: ChatTool, id: string, random: string): string
/** The new file's path, or null when the folder or file could not be made safely. */
export function writeChatScript(options: { dir: string; name: string; text: string; now?: () => number }): string | null

export interface ChatResume {
  available(): Promise<{ available: boolean; terminal: TerminalId }>
  resume(value: unknown): Promise<ChatResumeResult>
}

export function createChatResume(deps: {
  platform: string
  isQuitting: () => boolean
  viewer: { getJson(route: string): Promise<unknown> }
  isDirectory: (folder: string) => boolean
  terminal: { read(): Promise<unknown>; run(command: TerminalCommand): Promise<TerminalRun> }
  scriptDir: string
  writeScript?: (dir: string, name: string, text: string) => string | null
  now?: () => number
  random?: () => string
}): ChatResume

export function registerChatResumeIpc(options: {
  ipcMain: { handle(channel: string, handler: (event: never, ...args: never[]) => unknown): unknown }
  platform: string
  settled: () => Promise<unknown>
  isOwned: (event: never) => boolean
  chatResume: () => ChatResume
}): void
