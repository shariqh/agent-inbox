export type DraftResponseKind = 'answer' | 'clarify' | 'decline'

/** The reply intent a draft was sent (or last tried) with, and the window identity that claimed it. */
export interface DraftIntent {
  clientId: string
  sequence: number
  actionId: string
}

export type Draft =
  | {
      type: 'reply'
      itemId: string
      title: string
      text: string
      context: string
      /** the question's response revision the draft was written against */
      responseRevision: number
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
export function readDrafts(raw: string | null, nowMs: number, limits?: DraftLimits): Map<string, StoredDraft>
export function mergeDrafts(
  raw: string | null,
  changes: { upserts: Map<string, unknown>; deletes: Map<string, number> },
  nowMs: number,
  limits?: DraftLimits,
): string
