// Type declarations for electron/launch-ipc.cjs (issue #412 step 3).
import type { LaunchController } from './launch-controller.cjs'
export function registerLaunchIpc(options: {
  ipcMain: { handle(channel: string, handler: (event: never, ...args: never[]) => unknown): unknown }
  controller: () => LaunchController
  settings: { setEnabled(enabled: boolean): Promise<{ enabled: boolean; refused?: string }> }
  settled: () => Promise<unknown>
  isOwned: (event: never) => boolean
  isGranted: (event: never) => boolean
  onEnabled: (enabled: boolean) => void
}): void
