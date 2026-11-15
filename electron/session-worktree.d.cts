// Type declarations for electron/session-worktree.cjs (issue #432).
export function isRepositoryTop(folder: string, options?: { fsImpl?: unknown }): boolean
/** #586 phase 2: a .git folder or file at the folder or up to 10 levels above it (lstat only). */
export function insideRepository(folder: unknown, options?: { fsImpl?: unknown }): boolean
export function worktreeSlug(task: string): string
export function worktreeRepoName(project: unknown, folder: string): string
export function planWorktree(facts: { root: string; project: unknown; folder: string; task: string; launchId: string }): { path: string; branch: string }
export function worktreeRootProblem(root: unknown, options?: { fsImpl?: unknown }): string | null
export function worktreeProblem(facts: { folder: string; root: string; defaultRoot: string; plan: { path: string; branch: string }; fsImpl?: unknown }): string | null
