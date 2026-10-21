// test/scratch.ts — temporary directories removed after each test (#240) or,
// at the latest, after each test file (#245), so repeated runs do not fill
// $TMPDIR with scratch HOMEs, databases and runtimes.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// test/scratch-setup.ts removes whatever a file left when the file ends. A file
// that makes scratch directories only inside its tests, directly or through a
// helper such as hooks-runtime.ts, also calls removeScratchDirs() from its afterEach.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []

/** A new directory under $TMPDIR, removed by the next removeScratchDirs(). */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** Remove every scratch directory made since the last call. */
export function removeScratchDirs(): void {
  // maxRetries: a child process a test just stopped may still be closing files
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}
