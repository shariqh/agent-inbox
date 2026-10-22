// Types for public/link-open.js (issue #300).
export interface LinkRequestResult { ok: boolean; action?: string; reason?: string }

export function linkOpenMessage(
  result: LinkRequestResult | null | undefined,
  request: { kind: 'web'; url: string } | { kind: 'file'; path: string; reveal: boolean },
  opts?: { finder?: string },
): string

export function linkFileActions(opts?: {
  bridge?: () => { open?: unknown } | null | undefined
  platform?: string
}): { reveal: string } | null

export function initLinkOpening(opts?: {
  documentRef?: Document
  bridge?: () => { open(request: unknown): Promise<LinkRequestResult> } | null | undefined
  finder?: string
}): void
