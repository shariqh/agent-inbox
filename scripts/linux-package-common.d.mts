export class LinuxPackageTreeError extends Error {}
export function normalizeTreeTimes(path: string, seconds: number): void
export function normalizeDirectoryModes(path: string): void
export function copyPlainTreeWithDeterministicModes(
  source: string,
  destination: string,
  sourceRoot?: string,
): void
export function assertChromeSandboxInput(app: string): void
export function renderLinuxDesktopEntry(
  desktop: {
    type: string
    name: string
    comment: string
    exec: string
    icon: string
    categories: string[]
    terminal: boolean
  },
  extraFields?: ReadonlyArray<readonly [string, string]>,
): string
