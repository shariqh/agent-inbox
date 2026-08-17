import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function records(root, directory = root) {
  const result = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const stat = lstatSync(path)
    const key = relative(root, path).split(sep).join('/')
    if (stat.isDirectory()) {
      result.push(...records(root, path))
    } else if (stat.isSymbolicLink()) {
      result.push(['symlink', key, readlinkSync(path)])
    } else if (stat.isFile()) {
      result.push([
        'file',
        key,
        stat.mode & 0o777,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ])
    }
  }
  return result
}

export function treeIdentity(root) {
  return `sha256:${createHash('sha256').update(JSON.stringify(records(root))).digest('hex')}`
}
