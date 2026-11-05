export type DraftResponseKind = 'answer' | 'clarify' | 'decline'

/**
 * A question's answer as a draft or a reply intent last saw it: when it was
 * written, by whom (`inbox` or `agent`), of what kind and its text. A Note
 * does not move it.
 */
export interface DraftAnswer {
  at: string | null
  source: string | null
  kind: string | null
  text: string | null
}

/** The reply intent a draft was sent (or last tried) with, and the window identity that claimed it. */
export interface DraftIntent {
  clientId: string
  sequence: number
  actionId: string
  /** the question's answer when the intent was claimed; null when unknown, which is never replayed */
  pin: DraftAnswer | null
}

export type Draft =
  | {
      type: 'reply'
      itemId: string
      title: string
      text: string
      context: string
      /** the question's answer when the draft was last edited; null when unknown */
      answer: DraftAnswer | null
      intent: DraftIntent | null
    }
  | {
      type: 'item-recovery'
      itemId: string
      title: string
      text: string
      context: string
      kind: DraftResponseKind
      intent: DraftIntent | null
      reason: string
    }
  | {
      type: 'row'
      rowId: string
      boardId: string
      boardRevision: number
      revision: number
      actionVersion: number | null
      text: string
      kind: DraftResponseKind
      boardTitle: string
      label: string
      context: string
      setAside: boolean
      /** its send was in flight, or lost its answer, when this was written */
      unconfirmed: boolean
    }
  | {
      type: 'row-recovery'
      rowId: string
      revision: number
      actionVersion: number | null
      text: string
      kind: DraftResponseKind
      boardTitle: string
      label: string
      context: string
      setAside: boolean
      reason: string
    }
  | {
      type: 'note'
      itemId: string
      title: string
      text: string
      error: string
      pending: boolean
    }
  | {
      /** #411: the human's unsent message to one MCP session */
      type: 'message'
      session: string
      project: string
      agent: string
      stream: string
      text: string
      /** the id a send claimed and the text it sent: a retry of that text replays it exactly */
      intent: { id: string; text: string } | null
      /** non-empty while it waits in the unsent responses */
      reason: string
    }

export interface StoredDraft {
  savedAt: number
  draft: Draft
}

export interface DraftLimits {
  retentionMs?: number
  maxEntries?: number
  maxChars?: number
}

export const DRAFTS_KEY: string
export function draftEntry(raw: unknown): Draft | null
export function draftKey(draft: Draft): string | null
export function draftExpired(savedAt: number, nowMs: number, retentionMs?: number): boolean
export function readDrafts(raw: string | null, nowMs: number, limits?: DraftLimits): Map<string, StoredDraft>
export function mergeDrafts(
  raw: string | null,
  changes: { upserts: Map<string, unknown>; deletes: Map<string, number> },
  nowMs: number,
  limits?: DraftLimits,
): string
