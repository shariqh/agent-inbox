export class PruneElectronLocalesError extends Error {}
export function pruneElectronLocales(
  app: string,
  platform: 'darwin' | 'linux' | 'win32',
): { removedLocales: number; removedBytes: number }
export function assertEnglishOnlyElectronLocales(app: string, platform: 'darwin' | 'linux' | 'win32', label: string): void
