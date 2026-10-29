import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class UnsafeTreeModeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsafeTreeModeError'
  }
}

const LISTED = 10

function octal(mode) {
  return mode.toString(8).padStart(4, '0')
}

// Refuses any group- or other-writable entry and any setuid, setgid or sticky bit in an app
// tree (#378). `privileged` maps a relative path to the exact modes its regular file may
// carry with a special bit (chrome-sandbox's 04755 in a Linux package). A symlink is not
// judged: Linux has no link modes and access goes through its target, which is checked as
// an entry of its own when it lies in the tree. Links are never followed.
export function assertSafeTreeModes(root, { label, privileged = {} } = {}) {
  const found = []
  const visit = (path, rel) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    const mode = stat.mode & 0o7777
    const reasons = []
    if (mode & 0o022) reasons.push('group/other-writable')
    if (mode & 0o7000) {
      const allowed = Object.hasOwn(privileged, rel) ? privileged[rel] : []
      if (!stat.isFile() || !allowed.includes(mode)) reasons.push('setuid/setgid/sticky')
    }
    if (reasons.length > 0) found.push(`${rel} ${octal(mode)} (${reasons.join(', ')})`)
    if (!stat.isDirectory()) return
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), rel === '.' ? name : `${rel}/${name}`)
    }
  }
  visit(root, '.')
  if (found.length === 0) return
  const more = found.length > LISTED ? `; and ${found.length - LISTED} more` : ''
  throw new UnsafeTreeModeError(
    `${label ?? root} has ${found.length} unsafe file mode(s): ${found.slice(0, LISTED).join('; ')}${more}`,
  )
}
