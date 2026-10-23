#!/usr/bin/env node
// #87 installer spike (CI only): the upgrade build is this same commit with only
// its release version bumped by one patch, so an installer can be upgraded to it.
// --print writes base= and upgrade= lines for $GITHUB_OUTPUT. --apply rewrites the
// three places the release version lives (package.json, package-lock.json and
// src/version.ts, which test/release-pipeline.test.ts keeps in step).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (name) => readFileSync(join(root, name), 'utf8')
const writeJson = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`)

const pkg = JSON.parse(read('package.json'))
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
if (!match) throw new Error(`the spike needs a plain major.minor.patch version, not ${pkg.version}`)
const upgrade = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`

const mode = process.argv[2]
if (mode === '--print') {
  process.stdout.write(`base=${pkg.version}\nupgrade=${upgrade}\n`)
} else if (mode === '--apply') {
  const lock = JSON.parse(read('package-lock.json'))
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package-lock.json does not carry package.json\'s version')
  }
  const source = read('src/version.ts')
  const declaration = `export const AGENT_INBOX_VERSION = '${pkg.version}'`
  if (source.split(declaration).length !== 2) throw new Error('src/version.ts must declare the version exactly once')
  pkg.version = upgrade
  lock.version = upgrade
  lock.packages[''].version = upgrade
  writeJson('package.json', pkg)
  writeJson('package-lock.json', lock)
  writeFileSync(join(root, 'src', 'version.ts'), source.replace(declaration, `export const AGENT_INBOX_VERSION = '${upgrade}'`))
  process.stdout.write(`${upgrade}\n`)
} else {
  throw new Error('usage: bump-version.mjs --print | --apply')
}
