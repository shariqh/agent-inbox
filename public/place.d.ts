/** An /api/activity row. The four fields say where a session runs; an older server's row has none of them. */
export interface PlaceRow {
  machine?: string | null
  desk?: string | null
  pane?: string | null
  remote_session?: string | null
  [key: string]: unknown
}
export function placeLine(row: PlaceRow | null | undefined): string
export function claudeSessionUrl(row: PlaceRow | null | undefined): string
export function attachCommand(row: PlaceRow | null | undefined): string
