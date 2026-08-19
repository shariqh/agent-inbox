export const APP_NAME: 'Agent Inbox'
export class ThinAppBuildError extends Error {}
export function npmCliForCurrentNode(): string
export function copyRequiredTree(repoRoot: string, stageRoot: string): void
export function publishAtomically(source: string, destination: string, force: boolean): void
export function findNativeAddon(root: string): string
export function copyElectronNotices(packagerOutput: string, app: string): void
export function runRuntimeSelftest(runtimeRoot: string): void
export function pruneNativeAddonBuildArtifacts(stageRoot: string): void
