// test/scratch.ts — temporary directories removed after each test (#240) or,
// at the latest, after each test file (#245), so repeated runs do not fill
// $TMPDIR with scratch HOMEs, databases and runtimes.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// test/scratch-setup.ts removes whatever a file left when the file ends. A file
// that makes scratch directories only inside its tests, directly or through a
// helper such as hooks-runtime.ts, also calls removeScratchDirs() from its afterEach.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []
// every scratch directory this file made, removed or not: an image attached from
// one keeps its path in `hdiutil info` after the directory is gone
const everMade: string[] = []

/** A new directory under $TMPDIR, removed by the next removeScratchDirs(). */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  everMade.push(dir)
  return dir
}

/** Remove every scratch directory made since the last call. */
export function removeScratchDirs(): void {
  // maxRetries: a child process a test just stopped may still be closing files
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * The disk images attached from a file inside `dir`, or inside any directory
 * when given a list (macOS only), with their whole-disk devices. One `hdiutil
 * info` call covers every directory. An image can be attached without a volume: `hdiutil
 * create -srcfolder` has left its write-once image that way, so the mount table
 * misses it and Finder cannot show it to eject. A directory matches with or
 * without the /private prefix $TMPDIR resolves to.
 */
export function attachedImagesUnder(dir: string | readonly string[]): Array<{ path: string; device: string }> {
  const dirs = typeof dir === 'string' ? [dir] : dir
  if (process.platform !== 'darwin' || dirs.length === 0) return []
  const info = spawnSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8', timeout: 60_000 })
  if (info.status !== 0 || typeof info.stdout !== 'string') return []
  const prefixes = dirs.flatMap((d) => [`${d}/`, d.startsWith('/private/') ? `${d.slice('/private'.length)}/` : `/private${d}/`])
  return info.stdout.split(/^=+$/m).flatMap((block) => {
    const path = /^image-path\s*:\s*(.+)$/m.exec(block)?.[1]?.trim()
    const device = /^(\/dev\/disk\d+)\s/m.exec(block)?.[1]
    return path !== undefined && device !== undefined && prefixes.some((prefix) => path.startsWith(prefix)) ? [{ path, device }] : []
  })
}

/** Force-detach every image attached from a file inside `dir`; returns their paths. */
export function detachImagesUnder(dir: string | readonly string[]): string[] {
  return attachedImagesUnder(dir).map(({ path, device }) => {
    spawnSync('/usr/bin/hdiutil', ['detach', '-force', device], { stdio: 'ignore', timeout: 60_000 })
    return path
  })
}

/** Detach whatever images this file's scratch directories still hold (the file-end hook): one `hdiutil info` for all of them. */
export function detachLeftoverImages(): string[] {
  if (process.platform !== 'darwin' || everMade.length === 0) return []
  return detachImagesUnder(everMade.splice(0))
}
