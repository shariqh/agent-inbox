// test/runtime-spellings.ts — other spellings of a runtime folder's path
// (issue #294) that reach the very same folder on macOS's APFS while differing
// from it as a string: another case, the other Unicode normalization form, and
// the Data volume's firmlink. The prune gate must keep a runtime that a host
// config reaches through any of them, so it compares folders by (dev, ino),
// never by path.
//
// A Linux file system has none of them: there each one names another file, or
// nothing at all. So each case runs only where a probe shows this file system
// has it: the macOS runners (APFS, case-insensitive) run all three, Linux runs
// none.
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './scratch.js'

/** A folder to put on a runtime root's path: its NFC and NFD forms differ. */
export const ACCENTED = 'Caf\u00e9'

/** A runtime root under `home` that every spelling below can respell: `<home>/Café/runtime`. */
export const accentedRoot = (home: string): string => join(home, ACCENTED, 'runtime')

function identity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

const SPELLINGS: Array<[string, (path: string) => string]> = [
  ['another case', (path) => path.replace(`/${ACCENTED}/runtime/`, `/${ACCENTED}/RUNTIME/`)],
  ['the other Unicode form', (path) => path.replace(`/${ACCENTED}/`, `/${ACCENTED.normalize('NFD')}/`)],
  ['the Data volume\'s firmlink', (path) => `/System/Volumes/Data${realpathSync(path)}`],
]

const probe = join(accentedRoot(scratchDir('runtime-spellings-')), 'probe')
mkdirSync(probe, { recursive: true })

/**
 * [label, spell, here]: `spell` respells an existing path under an
 * accentedRoot(), and `here` says whether this file system reaches the same
 * folder through it.
 */
export const RUNTIME_SPELLINGS: Array<[string, (path: string) => string, boolean]> = SPELLINGS.map(([label, spell]) => {
  let spelled: string | null = null
  try {
    spelled = spell(probe)
  } catch {
    // the firmlink spelling needs the path to resolve
  }
  return [label, spell, spelled !== null && spelled !== probe && identity(spelled) !== null && identity(spelled) === identity(probe)]
})
