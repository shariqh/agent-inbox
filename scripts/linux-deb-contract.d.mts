import type {
  LinuxDebArchitectureProfile,
  LinuxDebInputs,
} from './linux-deb-inputs.mjs'

export class LinuxDebContractError extends Error {}
export function debArtifactName(packageVersion: string, arch?: 'x64' | 'arm64'): string
export function renderDebLauncher(inputs: LinuxDebInputs): string
export function renderDebDesktopEntry(inputs: LinuxDebInputs): string
export function renderDebControl(
  inputs: LinuxDebInputs,
  profile: { target: 'linux-x64' | 'linux-arm64' } & LinuxDebArchitectureProfile,
  packageVersion: string,
  installedSize: number,
): string
export function installedSizeKiB(root: string): number
export function assertPinnedDpkgDeb(
  profile: { target: 'linux-x64' | 'linux-arm64' } & LinuxDebArchitectureProfile,
  inputs: LinuxDebInputs,
  run?: (...args: unknown[]) => string | Buffer,
): string
