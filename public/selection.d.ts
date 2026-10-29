export interface SelectionBookmark { rangeText: string; [key: string]: unknown }
export function captureSelection(documentRef?: Document): SelectionBookmark | null
export function restoreSelection(bookmark: SelectionBookmark | null, documentRef?: Document): void
export function isRestoredSelection(documentRef?: Document): boolean
export function sameSelection(left: SelectionBookmark | null, right: SelectionBookmark | null): boolean
