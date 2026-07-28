export interface BuildStampView {
  drift: string
  commit: string | null
  builtAt: string | null
  head: string | null
  repoRoot: string | null
}
export interface BuildSummary { text: string; command: string | null; tone: 'info' | 'warn' }
export function buildSummary(build: BuildStampView | null | undefined): BuildSummary | null
