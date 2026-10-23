export interface RuntimeLine { runtimeId: string; status: string; text: string }
export interface RuntimesAction { ids: string[]; label: string; hint: string }
export const RUNTIMES_LEAD: string
export const PROJECT_SCOPE_NOTE: string
/** issue #294 — a size as Settings says it: 171 MB, 850 KB. */
export function formatBytes(bytes: unknown): string
/** issue #294 — one line per runtime folder: its name, what uses it or why Setup leaves it, and its size. */
export function runtimeLines(runtimes: unknown, activity: unknown): RuntimeLine[]
/** issue #294 — the ONE action that removes every unused runtime, or null; `ids` is what it names, never sent. */
export function runtimesAction(runtimes: unknown): RuntimesAction | null
/** issue #294 — what the Runtimes block says when it offers no button for unused runtimes, or null. */
export function runtimesNote(runtimes: unknown, canRun: boolean): string | null
