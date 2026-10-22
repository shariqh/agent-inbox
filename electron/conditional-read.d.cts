export interface ConditionalResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type ConditionalFetch = (
  url: string,
  init: { headers?: Record<string, string> },
) => Promise<ConditionalResponse>

/** Issue #287 — reads that revalidate what they hold and reuse it on a 304. */
export function createConditionalReader(
  fetchImpl?: ConditionalFetch,
): <T = unknown>(url: string) => Promise<T>
