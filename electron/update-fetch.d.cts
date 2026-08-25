import type {
  UpdateInstallStrategy,
  UpdateRegistry,
  UpdateTargetPackageType,
} from './update-manifest.cjs'

export const MANIFEST_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json'
export const SIGNATURE_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'unverified'
  | 'unsupported'

export interface VerifiedAvailableUpdate {
  version: string
  tag: string
  releaseUrl: string
  target: {
    packageType: UpdateTargetPackageType
    installStrategy: UpdateInstallStrategy
  }
}

export interface UpdateRendererState {
  status: UpdateStatus
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  message: string
  available?: VerifiedAvailableUpdate
}

export interface FetchResponse {
  status: number
  headers?: { get(name: string): string | null }
  body?: {
    getReader?(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel?(): Promise<unknown>
      releaseLock?(): void
    }
    [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array | Buffer>
  } | null
}

export interface UpdateCheckOptions {
  fetchImpl(
    url: string,
    init: {
      redirect: 'manual'
      signal: AbortSignal
      headers: { 'cache-control': 'no-cache' }
    },
  ): Promise<FetchResponse>
  registry: UpdateRegistry
  currentVersion: string
  automaticChecks?: boolean
  platform: string
  arch: string
  isPackaged: boolean
  appImagePath?: string
  now?: () => Date
  timeoutMs?: number
  setTimeoutImpl?: (callback: () => void, delay: number) => unknown
  clearTimeoutImpl?: (timer: any) => void
}

export function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateRendererState>
