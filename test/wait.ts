// test/wait.ts — wait on a condition, not a fixed window (#471).
//
// A sleep sized for an idle machine loses under full-suite load. waitUntil polls
// until `read` returns a truthy value and returns it at once, so a generous
// deadline costs nothing when the machine is fast. The 10 s default stays under
// Vitest's 15 s testTimeout, so a miss fails with this file's label rather than
// a generic timeout; pass `ms` only when the test itself has a longer timeout.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
import { existsSync, readFileSync } from 'node:fs'

/** Poll `read` until it returns a truthy value; throw naming `label` after `ms`. */
export async function waitUntil<T>(read: () => T | undefined | false | null, label: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * The pid a child writes to `path`. Wait for the number, not the file: a shell
 * redirect or writeFileSync creates the file before it writes, and reading ''
 * gives pid 0, which kill() takes as this whole process group.
 */
export async function pidIn(path: string, ms?: number): Promise<number> {
  return waitUntil(() => {
    const pid = existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : 0
    return Number.isInteger(pid) && pid > 0 && pid
  }, `a pid in ${path}`, ms)
}
