export class LaunchLocaleError extends Error {}
export const PROBE: string
export const EXPECTED: Readonly<Record<'en-US' | 'en-GB', Readonly<{
  language: string
  intl: string
  lastChecked: string
  askedAt: string
}>>>
export function localeMismatches(observed: unknown, expected: Record<string, string>): string[]
export function viewerPage(targets: unknown, viewerPort: number): { webSocketDebuggerUrl: string, url: string } | undefined
export function probeLaunchLocale(options: {
  devtoolsPort: number
  viewerPort: number
  expect: string
  attempts?: number
  intervalMs?: number
  timeoutMs?: number
}): Promise<Record<string, unknown>>
