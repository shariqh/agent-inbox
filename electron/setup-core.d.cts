export interface SetupSelection {
  key: string
  sourceRoot: string
  manifestDigest: string
  packageVersion: string
}

export interface SetupRequest {
  target: string
  selection: SetupSelection
}

export interface SetupHost {
  platform: string
  arch: string
  key: string
}

export interface VerifiedSetupIdentity {
  sourceRoot: string
  manifestDigest: string
  packageVersion: string
  product: string
  runtimeId: string
  payloadDigest: string
  platform: string
  arch: string
  nodeMajor: number
  nodeModulesAbi: string
}

export interface SetupResult {
  ok: boolean
  exitCode: number | null
  output: string
  target: string
  timedOut: boolean
  cancelled: boolean
}

export interface SetupOperation {
  readonly target: string
  readonly sourceRoot: string
  readonly manifestDigest: string
  readonly packageVersion: string
  readonly host: Readonly<SetupHost>
}

export interface SetupExecutionAdapter {
  readonly id: string
  readonly host: Readonly<SetupHost>
  readonly releaseKeys: readonly string[]
  readonly targets: readonly string[]
  verify(request: Readonly<SetupRequest>): VerifiedSetupIdentity
  start(
    operation: Readonly<SetupOperation>,
    controls: { onCancel: (cancel: () => void) => void },
  ): Promise<SetupResult>
}

export function runTrustedSetup(options: {
  request: Readonly<SetupRequest>
  adapter: Readonly<SetupExecutionAdapter>
  onCancel: (cancel: () => void) => void
}): Promise<SetupResult>
