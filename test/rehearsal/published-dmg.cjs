'use strict'

// Checks a DMG a release published, before the hosted-runner rehearsal installs it (#381):
//
//   node test/rehearsal/published-dmg.cjs <folder> <version>
//
// <folder> holds what the release published: Agent-Inbox-v<version>-universal.dmg,
// SHA256SUMS.txt, update-manifest.json and update-manifest.json.sig. The DMG's SHA-256 must be
// the one SHA256SUMS.txt lists for it, and its size and SHA-256 those of the macOS target of
// update-manifest.json, whose signature must verify under release/update-keys.json.

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SUM_RE = /^([0-9a-f]{64}) [ *](.+)$/

async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function listedSha256(sums, filename) {
  const listed = sums
    .split('\n')
    .map((line) => SUM_RE.exec(line.replace(/\r$/, '')))
    .filter((match) => match !== null && match[2] === filename)
  if (listed.length !== 1) throw new Error(`SHA256SUMS.txt lists ${filename} ${listed.length} times, not once`)
  return listed[0][1]
}

/**
 * @param {object} options
 * @param {string} options.folder the release's downloaded files
 * @param {string} options.version the release, X.Y.Z
 * @param {object} [options.registry] the keys that may sign its update-manifest.json
 *   (default: this checkout's release/update-keys.json)
 */
async function checkPublishedDmg({ folder, version, registry }) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`${version} is not an X.Y.Z version`)
  const { parseRegistry, verifyManifest } = require(path.join(REPO_ROOT, 'electron', 'update-manifest.cjs'))
  const tag = `v${version}`
  const filename = `Agent-Inbox-${tag}-universal.dmg`
  const manifest = verifyManifest({
    manifestBytes: fs.readFileSync(path.join(folder, 'update-manifest.json')),
    envelope: fs.readFileSync(path.join(folder, 'update-manifest.json.sig')),
    registry: registry ?? parseRegistry(fs.readFileSync(path.join(REPO_ROOT, 'release', 'update-keys.json'))),
  })
  if (manifest.tag !== tag) throw new Error(`update-manifest.json describes ${manifest.tag}, not ${tag}`)
  const target = manifest.targets.find((candidate) => candidate.platform === 'darwin')
  if (target?.filename !== filename) throw new Error(`update-manifest.json names no ${filename}`)

  const dmg = path.join(folder, filename)
  const stat = fs.lstatSync(dmg)
  if (!stat.isFile()) throw new Error(`${filename} is not a regular file`)
  const sha256 = await fileSha256(dmg)
  if (sha256 !== listedSha256(fs.readFileSync(path.join(folder, 'SHA256SUMS.txt'), 'utf8'), filename)) {
    throw new Error(`${filename}'s SHA-256 ${sha256} is not the one SHA256SUMS.txt lists`)
  }
  if (stat.size !== target.byteLength || sha256 !== target.sha256) {
    throw new Error(`${filename} is not the file update-manifest.json describes (size or SHA-256 differs)`)
  }
  return { dmg, sha256, byteLength: stat.size }
}

module.exports = {
  checkPublishedDmg,
}

if (require.main === module) {
  const [folder, version] = process.argv.slice(2)
  checkPublishedDmg({ folder, version }).then(
    ({ dmg, sha256, byteLength }) => {
      process.stdout.write(`${path.basename(dmg)}: ${byteLength} bytes, SHA-256 ${sha256}, as SHA256SUMS.txt and the signed update-manifest.json of v${version} list it\n`)
    },
    (error) => {
      process.stderr.write(`published-dmg: ${error.message}\n`)
      process.exitCode = 1
    },
  )
}
