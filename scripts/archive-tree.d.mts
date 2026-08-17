export class ArchiveTreeError extends Error {}
export function createTreeArchive(options: { source: string; archive: string }): string
export function validateArchiveEntries(entries: string[], expectedRoot: string): string[]
export function extractTreeArchive(options: {
  archive: string
  destination: string
  expectedRoot: string
}): string
