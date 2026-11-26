/** How long a poll read may wait for its headers, or for the next bytes of a body being read. */
export const STALL_MS: number

/**
 * `start(signal)` makes the fetch. Its answer is passed through untouched when it has no readable
 * body; otherwise the body is read through a guard. Either wait running past STALL_MS aborts the
 * read and rejects.
 */
export function stallLimited(start: (signal: AbortSignal) => Promise<Response>): Promise<Response>
