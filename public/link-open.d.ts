// Types for public/link-open.js (issue #300).
export interface LinkRequestResult { ok: boolean; action?: string; reason?: string }

interface LinksBridge {
  open(request: unknown): Promise<LinkRequestResult>
  filesAvailable?(): Promise<boolean>
}

export function linkOpenMessage(
  result: LinkRequestResult | null | undefined,
  request: { kind: 'web'; url: string } | { kind: 'file'; path: string; reveal: boolean },
  opts?: { finder?: string },
): string

/** A file chip's Reveal and Copy path, only where main has said files may open. */
export function linkFileActions(opts?: {
  bridge?: () => { open?: unknown } | null | undefined
  platform?: string
  documentRef?: Document
}): { reveal: string } | null

/** Whether a file link copies its path here instead of opening it. */
export function fileLinksCopy(opts?: { documentRef?: Document; bridge?: () => { open?: unknown } | null | undefined }): boolean

/** Asks main again whether this page may open local files. */
export function refreshLinkPermission(documentRef?: Document): Promise<boolean>

export function initLinkOpening(opts?: {
  documentRef?: Document
  bridge?: () => LinksBridge | null | undefined
  finder?: string
}): void
