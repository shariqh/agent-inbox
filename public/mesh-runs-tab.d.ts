/** the card's last-run line from `/api/mesh/agents`'s `lastRun`; empty for a body without the key */
export function lastRunText(lastRun: { at: string; op?: string; outcome?: string } | null | undefined, nowMs: number): string

export function installRunsTab(deps: { doc: Document }): {
  /** paints Run history from the last runs body for the open agent, or nothing read yet */
  paint(panel: HTMLElement, input: { body: any; stale: boolean } | null, nowMs: number): void
  /** an agent opened: one page of rows; another agent's rows never show under this one's name */
  reset(otherAgent: boolean): void
  /** the window-local rows shown, for the page's state() */
  state(): string
}
