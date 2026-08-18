#!/usr/bin/env node
// Portable runtime payload primitives (issue #74, Layer 1).
//
// A "runtime payload" is a directory tree that will be shipped and installed
// outside Electron (a staged Node 24 + production node_modules + dist + the
// install scripts/docs it needs). This module is the STRUCTURAL layer that
// makes such a tree safe to trust and safe to install:
//
//   · buildManifest()   walks a payload tree into a deterministic, sorted
//                        manifest — same inputs always produce the same
//                        bytes, so two independent builds of the same source
//                        can be compared byte-for-byte.
//   · verifyPayload()    re-derives that manifest from the files actually on
//                        disk and rejects any divergence: tamper, truncation,
//                        a symlink slipped into the tree, a path that tries to
//                        escape the payload root, a missing entrypoint, or a
//                        payload built for the wrong platform/arch/version.
//   · installRuntime()   copies a verified payload into a runtime root via a
//                        same-parent temp directory + atomic rename, so a
//                        reader never observes a half-written runtime
//                        directory. Installing the exact same payload twice
//                        is a no-op; colliding with something else under the
//                        same runtime id is refused, never overwritten.
//   · pruneRuntime()     deletes exactly one runtime directory, and only if
//                        it is a real (non-symlink) child of the runtime root
//                        that itself carries a valid ownership manifest —
//                        never a glob, never "everything old".
//
// The manifest is an INTEGRITY contract, not an authenticity one: it proves
// "this is the tree that was built", not "you should trust this tree". Code
// signing/notarization is a separate concern layered on top, not here.
//
// No dependencies beyond Node core — this has to run from the bundled runtime
// itself, before any node_modules exist, and be trivially callable from Bash.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { parseArgs } from 'node:util'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createSetupFilesystem } = require('./setup-filesystem.cjs')
const setupFilesystem = createSetupFilesystem()

export const MANIFEST_SCHEMA = 1
export const DEFAULT_MANIFEST_FILE = 'runtime-manifest.json'

export class RuntimeIntegrityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeIntegrityError'
  }
}

function toPosix(p) {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Reject anything a manifest path must never be: absolute, empty, or able to escape the root. */
function assertSafeRelativePath(relPath) {
  if (!relPath || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new RuntimeIntegrityError(`unsafe payload path (absolute): ${relPath}`)
  }
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new RuntimeIntegrityError(`unsafe payload path (traversal): ${relPath}`)
    }
  }
}

/**
 * Reject anything a single filesystem path COMPONENT must never be: not a
 * non-empty string, containing a path separator (`/` or `\`) or a NUL byte,
 * or exactly `.`/`..`. Used for the identity fields (`product`,
 * `packageVersion`, `platform`, `arch`) that feed `computeRuntimeId()` and
 * for the resulting `runtimeId` itself — every one of them is eventually
 * `join()`-ed directly onto `runtimeRoot` as a single directory-name
 * segment (installRuntime/pruneRuntime), so a manifest whose identity
 * fields are merely "truthy" (the previous check) rather than actually
 * safe path components could let a hand-crafted or hand-edited manifest
 * make `runtimeId` — and therefore the install/prune destination — escape
 * `runtimeRoot` entirely (e.g. `product: '../../../tmp/evil'`). This must
 * be checked both when a manifest is BUILT (buildManifest, so our own tools
 * never produce an unsafe one) and again whenever one is VERIFIED
 * (verifyPayload, since the manifest on disk did not necessarily come from
 * our own buildManifest — it could be hand-edited, or produced by a rogue
 * or older tool — and verifyPayload's digest/runtimeId self-consistency
 * check alone does NOT catch this: an attacker who controls every field
 * simply recomputes a self-consistent digest around their malicious value).
 */
function assertSafePathComponent(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new RuntimeIntegrityError(`unsafe ${label}: must be a non-empty string`)
  }
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new RuntimeIntegrityError(`unsafe ${label}: ${JSON.stringify(value)}`)
  }
}

/**
 * Re-derive `runtimeRoot/<runtimeId>` and require it to be an exact,
 * single-segment, direct child of `runtimeRoot` — never a multi-segment
 * path and never anything that resolves outside it. This is the LAST gate,
 * called immediately before a runtimeId is ever joined onto a real
 * dest/temp/rename filesystem operation (installRuntime, pruneRuntime) —
 * deliberately redundant with buildManifest/verifyPayload's own
 * assertSafePathComponent() checks on the same value, so that a future
 * caller that obtains a runtimeId from anywhere other than a freshly
 * verified manifest (or a refactor that reorders those checks) still can
 * never publish or delete outside runtimeRoot.
 */
function assertRuntimeIdContained(runtimeRoot, runtimeId) {
  assertSafePathComponent(runtimeId, 'runtimeId')
  const targetDir = join(runtimeRoot, runtimeId)
  if (dirname(resolve(targetDir)) !== resolve(runtimeRoot)) {
    throw new RuntimeIntegrityError(`runtimeId does not resolve to a direct child of runtimeRoot: ${runtimeId}`)
  }
  return targetDir
}

/** sha256 of a file's bytes, hex-encoded. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Walk `root` and return every regular file as a sorted, POSIX-relative path.
 * Throws RuntimeIntegrityError on a symlink or any non-regular-file entry
 * anywhere in the tree — a payload tree must be fully "flat truth", never a
 * link a later step could be tricked into following outside the root.
 * `skip` (a Set of root-relative POSIX paths) lets callers omit the manifest
 * file itself, which does not exist yet while it is being built.
 */
export function walkFiles(root, skip = new Set()) {
  const out = []
  const stack = ['']
  while (stack.length > 0) {
    const relDir = stack.pop()
    const absDir = relDir ? join(root, relDir) : root
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      const posixRel = toPosix(relPath)
      if (skip.has(posixRel)) continue
      const absPath = join(absDir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new RuntimeIntegrityError(`symlink not allowed in payload: ${posixRel}`)
      } else if (entry.isDirectory()) {
        stack.push(relPath)
      } else if (entry.isFile()) {
        out.push(posixRel)
      } else {
        throw new RuntimeIntegrityError(`unsupported file type in payload: ${posixRel}`)
      }
    }
  }
  out.sort()
  return out
}

/** Deterministic hash over manifest metadata + sorted file records. Excludes the manifest file itself by construction (callers never pass it in `files`). */
export function computePayloadDigest({
  product, packageVersion, sourceCommit, platform, arch, nodeVersion, nodeModulesAbi, entrypoints, files,
}) {
  const hash = createHash('sha256')
  const meta = JSON.stringify({
    product,
    packageVersion,
    sourceCommit: sourceCommit ?? null,
    platform,
    arch,
    nodeVersion,
    nodeModulesAbi,
    entrypoints: [...entrypoints].sort(),
  })
  hash.update(meta)
  hash.update('\n')
  for (const file of files) {
    hash.update(`${file.path}\u0000${file.size}\u0000${file.mode.toString(8)}\u0000${file.sha256}\n`)
  }
  return hash.digest('hex')
}

export function computeRuntimeId({ product, packageVersion, platform, arch, payloadDigest }) {
  return `${product}-${packageVersion}-${platform}-${arch}-${payloadDigest.slice(0, 16)}`
}

/**
 * Build a manifest for `root`. `entrypoints` are root-relative POSIX paths
 * that MUST already exist among the walked files — a payload with a missing
 * entrypoint is not a payload, it is a broken build.
 */
export function buildManifest({
  root, product, packageVersion, sourceCommit, platform, arch, nodeVersion, nodeModulesAbi, entrypoints,
  manifestFileName = DEFAULT_MANIFEST_FILE,
}) {
  if (!product || !packageVersion || !platform || !arch || !nodeVersion || !nodeModulesAbi) {
    throw new RuntimeIntegrityError('buildManifest: product, packageVersion, platform, arch, nodeVersion and nodeModulesAbi are all required')
  }
  assertSafePathComponent(product, 'product')
  assertSafePathComponent(packageVersion, 'packageVersion')
  assertSafePathComponent(platform, 'platform')
  assertSafePathComponent(arch, 'arch')
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
    throw new RuntimeIntegrityError('buildManifest: at least one entrypoint is required')
  }
  const paths = walkFiles(root, new Set([manifestFileName]))
  const files = paths.map((relPath) => {
    assertSafeRelativePath(relPath)
    const absPath = join(root, relPath)
    const stat = statSync(absPath)
    return { path: relPath, size: stat.size, mode: stat.mode & 0o777, sha256: sha256File(absPath) }
  })
  const fileSet = new Set(files.map((f) => f.path))
  for (const entry of entrypoints) {
    if (!fileSet.has(entry)) {
      throw new RuntimeIntegrityError(`buildManifest: entrypoint not found in payload: ${entry}`)
    }
  }
  const payloadDigest = computePayloadDigest({
    product, packageVersion, sourceCommit, platform, arch, nodeVersion, nodeModulesAbi, entrypoints, files,
  })
  const runtimeId = computeRuntimeId({ product, packageVersion, platform, arch, payloadDigest })
  assertSafePathComponent(runtimeId, 'runtimeId')
  return {
    schema: MANIFEST_SCHEMA,
    product,
    packageVersion,
    sourceCommit: sourceCommit ?? null,
    platform,
    arch,
    nodeVersion,
    nodeModulesAbi,
    entrypoints: [...entrypoints],
    files,
    payloadDigest,
    runtimeId,
  }
}

export function writeManifestFile(root, manifest, manifestFileName = DEFAULT_MANIFEST_FILE) {
  writeFileSync(join(root, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Read and JSON-parse the manifest at `root/manifestFileName`. Requires the
 * manifest path to `lstat` as a plain, non-symlink regular file BEFORE it is
 * ever read — walkFiles()/buildManifest() skip this exact filename when
 * walking the payload tree (it does not exist yet while being built, and is
 * never itself one of the manifested files), and that skip is purely a
 * name-based exclusion: it does not, and structurally cannot, also assert
 * that whatever sits at that name is a real file rather than a symlink. A
 * symlinked manifest entry could otherwise point at a byte-identical, fully
 * valid manifest living OUTSIDE this directory (a different, legitimately
 * verified runtime's manifest, or one shared on purpose) and every
 * downstream check here — schema, files, digest, runtimeId — would pass
 * without ever noticing the directory does not actually, physically own
 * its own ownership record. Ownership must be a property of this exact
 * directory, not of wherever a link happens to resolve.
 */
export function readManifestFile(root, manifestFileName = DEFAULT_MANIFEST_FILE) {
  const manifestPath = join(root, manifestFileName)
  try {
    setupFilesystem.identify(manifestPath, 'file')
  } catch (err) {
    if (err?.code === 'not-found') throw new RuntimeIntegrityError(`no manifest at ${manifestPath}`)
    throw new RuntimeIntegrityError(
      `manifest must be a plain regular file, not a symlink or other special file: ${manifestPath} (${err.message})`,
    )
  }
  const raw = readFileSync(manifestPath, 'utf8')
  return JSON.parse(raw)
}

/**
 * Re-derive the manifest from the files actually on disk at `root` and
 * compare it against the stored one, field by field and file by file.
 * Returns the manifest on success; throws RuntimeIntegrityError with a
 * specific, actionable message otherwise. `expect` is an optional subset of
 * {platform, arch, packageVersion, nodeVersion, product} the caller already
 * knows and wants enforced (e.g. "this must be the darwin/arm64 payload").
 */
export function verifyPayload({ root, manifestFileName = DEFAULT_MANIFEST_FILE, expect = {} }) {
  let manifest
  try {
    manifest = readManifestFile(root, manifestFileName)
  } catch (err) {
    if (err instanceof RuntimeIntegrityError) throw err
    throw new RuntimeIntegrityError(`manifest is not valid JSON: ${err.message}`)
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new RuntimeIntegrityError(`unsupported manifest schema: ${manifest.schema}`)
  }
  // Structural identity gate: these fields feed computeRuntimeId() and are
  // each `join()`-ed directly onto runtimeRoot as a single path segment at
  // install/prune time, so they must be actually-safe path components — not
  // merely present — regardless of whether the recomputed digest/runtimeId
  // below happens to self-consistently match (an attacker who controls
  // every field can always make that comparison pass around a malicious
  // value; this check does not depend on that comparison at all).
  assertSafePathComponent(manifest.product, 'manifest.product')
  assertSafePathComponent(manifest.packageVersion, 'manifest.packageVersion')
  assertSafePathComponent(manifest.platform, 'manifest.platform')
  assertSafePathComponent(manifest.arch, 'manifest.arch')
  assertSafePathComponent(manifest.runtimeId, 'manifest.runtimeId')
  if (!Array.isArray(manifest.files)) {
    throw new RuntimeIntegrityError('manifest.files is missing or not an array')
  }

  const seen = new Set()
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || typeof file.size !== 'number'
      || typeof file.mode !== 'number' || typeof file.sha256 !== 'string') {
      throw new RuntimeIntegrityError(`malformed file record: ${JSON.stringify(file)}`)
    }
    assertSafeRelativePath(file.path)
    if (seen.has(file.path)) {
      throw new RuntimeIntegrityError(`duplicate path in manifest: ${file.path}`)
    }
    seen.add(file.path)
  }

  // The tree on disk must contain EXACTLY the manifested files — no extras,
  // no symlinks anywhere (walkFiles itself throws on any symlink it meets).
  const onDisk = walkFiles(root, new Set([manifestFileName]))
  const onDiskSet = new Set(onDisk)
  for (const relPath of onDisk) {
    if (!seen.has(relPath)) {
      throw new RuntimeIntegrityError(`unmanifested file present in payload: ${relPath}`)
    }
  }
  for (const relPath of seen) {
    if (!onDiskSet.has(relPath)) {
      throw new RuntimeIntegrityError(`manifested file missing from payload: ${relPath}`)
    }
  }

  for (const file of manifest.files) {
    const absPath = join(root, file.path)
    let stat
    try {
      stat = lstatSync(absPath)
    } catch {
      throw new RuntimeIntegrityError(`manifested file missing: ${file.path}`)
    }
    if (stat.isSymbolicLink()) {
      throw new RuntimeIntegrityError(`symlink not allowed in payload: ${file.path}`)
    }
    if (!stat.isFile()) {
      throw new RuntimeIntegrityError(`not a regular file: ${file.path}`)
    }
    if (stat.size !== file.size) {
      throw new RuntimeIntegrityError(`size mismatch for ${file.path}: expected ${file.size}, found ${stat.size}`)
    }
    if ((stat.mode & 0o777) !== file.mode) {
      throw new RuntimeIntegrityError(
        `mode mismatch for ${file.path}: expected ${file.mode.toString(8)}, found ${(stat.mode & 0o777).toString(8)}`,
      )
    }
    const actualSha = sha256File(absPath)
    if (actualSha !== file.sha256) {
      throw new RuntimeIntegrityError(`checksum mismatch for ${file.path}`)
    }
  }

  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length === 0) {
    throw new RuntimeIntegrityError('manifest has no entrypoints')
  }
  for (const entry of manifest.entrypoints) {
    if (!seen.has(entry)) {
      throw new RuntimeIntegrityError(`entrypoint missing from payload: ${entry}`)
    }
  }

  const recomputedDigest = computePayloadDigest(manifest)
  if (recomputedDigest !== manifest.payloadDigest) {
    throw new RuntimeIntegrityError('payload digest mismatch — manifest does not match its own file list')
  }
  const recomputedId = computeRuntimeId({ ...manifest, payloadDigest: recomputedDigest })
  if (recomputedId !== manifest.runtimeId) {
    throw new RuntimeIntegrityError('runtimeId mismatch — manifest does not match its own digest')
  }

  for (const [key, value] of Object.entries(expect)) {
    if (value !== undefined && manifest[key] !== value) {
      throw new RuntimeIntegrityError(`manifest.${key} mismatch: expected ${value}, found ${manifest[key]}`)
    }
  }

  return manifest
}

/**
 * Copy every file from `srcRoot` into `destRoot`, preserving POSIX mode bits
 * and rejecting any symlink encountered on either side. Directories are
 * created as needed; `destRoot` must be absent unless the caller explicitly
 * supplies the empty, adapter-created staging directory. Content is never
 * merged into a nonempty tree.
 */
export function copyTreePreservingMode(srcRoot, destRoot, { allowExistingEmpty = false } = {}) {
  if (existsSync(destRoot)) {
    const destStat = lstatSync(destRoot)
    if (!allowExistingEmpty || destStat.isSymbolicLink() || !destStat.isDirectory() ||
        readdirSync(destRoot).length > 0) {
      throw new RuntimeIntegrityError(`copy destination already exists: ${destRoot}`)
    }
  } else {
    mkdirSync(destRoot, { recursive: true })
  }
  const relPaths = walkFiles(srcRoot)
  for (const relPath of relPaths) {
    const srcPath = join(srcRoot, relPath)
    const destPath = join(destRoot, relPath)
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(srcPath, destPath)
    const mode = statSync(srcPath).mode & 0o777
    chmodSync(destPath, mode)
  }
  return relPaths
}

// Never resolved through PATH — a fixed system path, exactly like this
// repo's "always the distribution's own npm-cli.js, never ambient npm" rule.
// A test harness may point AGENT_INBOX_XATTR_BIN at a fixture script to
// exercise the failure path deterministically; production installs never
// set that variable, so the fixed system binary is what actually runs.
const DARWIN_XATTR_BIN = process.env.AGENT_INBOX_XATTR_BIN || '/usr/bin/xattr'

/**
 * Strip any inherited `com.apple.quarantine` extended attribute from a
 * freshly-copied temp install tree on Darwin, using the fixed system
 * `/usr/bin/xattr` — never a PATH-resolved `xattr`, which a hostile PATH
 * could shadow. `copyTreePreservingMode()` only preserves POSIX mode bits;
 * it does not touch (and cannot be relied on to drop) extended attributes,
 * so a payload that reached this machine via a quarantine-aware path (e.g.
 * extracted from a downloaded archive) could otherwise carry Gatekeeper's
 * "downloaded from the internet" flag straight into the installed runtime.
 *
 * A no-op off Darwin, and a no-op when the fixed xattr binary is not present
 * at all (nothing to enforce). But if the binary IS present and actually
 * fails to run, that is treated as a hard failure: the install must never
 * publish a tree whose quarantine state we tried and failed to clear.
 * `xattr -rd` is idempotent — files that never carried the attribute are
 * left alone without error — so a clean run removing zero attributes is the
 * ordinary case, not a failure.
 */
function clearDarwinQuarantine(destDir) {
  if (process.platform !== 'darwin') return
  if (!existsSync(DARWIN_XATTR_BIN)) return
  try {
    execFileSync(DARWIN_XATTR_BIN, ['-rd', 'com.apple.quarantine', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
  } catch (err) {
    throw new RuntimeIntegrityError(`failed to clear com.apple.quarantine from ${destDir}: ${err.message}`)
  }
}

/**
 * Install a verified payload into `runtimeRoot`, keyed by its runtimeId.
 *
 *  · Verifies the SOURCE payload first — nothing unverified is ever copied.
 *  · Copies into an isolated same-parent transaction directory under
 *    runtimeRoot so the rename that publishes it stays on one filesystem.
 *  · On Darwin, clears any inherited `com.apple.quarantine` xattr from that
 *    temp copy before re-verifying it — see clearDarwinQuarantine() above.
 *  · Re-verifies the COPY before publishing — a torn copy must never become
 *    visible under the final name.
 *  · If `runtimeRoot/<runtimeId>` already exists: identical verified content
 *    is a no-op (idempotent install); anything else is a refused collision.
 */
export function installRuntime({ payloadRoot, runtimeRoot, manifestFileName = DEFAULT_MANIFEST_FILE, expect = {} }) {
  const sourceIdentity = setupFilesystem.identify(payloadRoot, 'directory')
  const sourceManifest = verifyPayload({ root: payloadRoot, manifestFileName, expect })
  setupFilesystem.assertIdentity(sourceIdentity)
  const { runtimeId } = sourceManifest
  mkdirSync(runtimeRoot, { recursive: true })
  // Last gate before runtimeId ever touches a real filesystem operation —
  // see assertRuntimeIdContained()'s doc comment. Deliberately re-checked
  // here even though verifyPayload() above already validated this exact
  // runtimeId as a safe path component.
  const destDir = assertRuntimeIdContained(runtimeRoot, runtimeId)

  if (existsSync(destDir)) {
    let destinationIdentity
    try {
      destinationIdentity = setupFilesystem.identify(destDir, 'directory')
    } catch (err) {
      if (err?.code === 'link-like-entry') {
        throw new RuntimeIntegrityError(`refusing to install over a symlink or link-like entry: ${destDir}`)
      }
      throw new RuntimeIntegrityError(`runtime id collision: ${destDir} is not a plain directory (${err.message})`)
    }
    let existingManifest
    try {
      existingManifest = verifyPayload({ root: destDir, manifestFileName, expect: { runtimeId } })
    } catch (err) {
      throw new RuntimeIntegrityError(
        `runtime id collision: ${destDir} exists but is not a valid, matching runtime (${err.message})`,
      )
    }
    setupFilesystem.assertIdentity(destinationIdentity)
    if (existingManifest.payloadDigest !== sourceManifest.payloadDigest) {
      throw new RuntimeIntegrityError(`runtime id collision: ${destDir} exists with a different payload digest`)
    }
    return { installed: false, runtimeId, path: destDir }
  }

  const publication = setupFilesystem.stageDirectory({
    destination: destDir,
    replacement: 'refuse',
    prepare(tempDir) {
      setupFilesystem.assertIdentity(sourceIdentity)
      copyTreePreservingMode(payloadRoot, tempDir, { allowExistingEmpty: true })
      setupFilesystem.assertIdentity(sourceIdentity)
      clearDarwinQuarantine(tempDir)
    },
    validate(tempDir) {
      verifyPayload({ root: tempDir, manifestFileName, expect: { runtimeId } })
    },
  })
  return { installed: true, runtimeId, path: publication.path }
}

/**
 * Delete exactly one runtime directory: `runtimeRoot/<runtimeId>`. Refuses
 * unless that path is a direct, non-symlink child of runtimeRoot carrying a
 * valid ownership manifest whose own runtimeId matches — this is never a
 * glob and never "clean up everything old".
 */
export function pruneRuntime({ runtimeRoot, runtimeId, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  const targetDir = assertRuntimeIdContained(runtimeRoot, runtimeId)
  try {
    setupFilesystem.removeDirectory({
      target: targetDir,
      validate(path) {
        verifyPayload({ root: path, manifestFileName, expect: { runtimeId } })
      },
    })
  } catch (err) {
    if (err instanceof RuntimeIntegrityError) throw err
    if (err?.code === 'not-found') throw new RuntimeIntegrityError(`no such runtime: ${targetDir}`)
    if (err?.code === 'link-like-entry') {
      throw new RuntimeIntegrityError(`refusing to prune a symlink or link-like entry: ${targetDir}`)
    }
    if (err?.code === 'wrong-kind') {
      throw new RuntimeIntegrityError(`not a directory, refusing to prune: ${targetDir}`)
    }
    throw err
  }
  return { pruned: true, runtimeId, path: targetDir }
}

/**
 * List every direct child of `runtimeRoot`, reporting whether each one is a
 * validly-owned runtime directory. Never mutates anything — used by prune
 * tooling and runtime-config.mjs's ownership checks to enumerate candidates.
 */
export function listRuntimes({ runtimeRoot, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  if (!existsSync(runtimeRoot)) return []
  const out = []
  for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const dir = join(runtimeRoot, entry.name)
    try {
      const manifest = verifyPayload({ root: dir, manifestFileName })
      out.push({ runtimeId: entry.name, path: dir, valid: manifest.runtimeId === entry.name })
    } catch {
      out.push({ runtimeId: entry.name, path: dir, valid: false })
    }
  }
  out.sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0))
  return out
}

// ── CLI ─────────────────────────────────────────────────────────────────
// Every subcommand prints one JSON object/array to stdout and exits 0 on
// success, or prints a one-line error to stderr and exits 1 — deliberately
// simple enough for a Bash caller (install scripts, stage-runtime.mjs) to
// consume with plain shell/grep, no jq required.

function runManifestCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      product: { type: 'string' },
      'package-version': { type: 'string' },
      'source-commit': { type: 'string' },
      platform: { type: 'string' },
      arch: { type: 'string' },
      'node-version': { type: 'string' },
      'node-modules-abi': { type: 'string' },
      entrypoint: { type: 'string', multiple: true },
      'manifest-file': { type: 'string' },
    },
  })
  const manifest = buildManifest({
    root: resolve(values.root),
    product: values.product,
    packageVersion: values['package-version'],
    sourceCommit: values['source-commit'],
    platform: values.platform,
    arch: values.arch,
    nodeVersion: values['node-version'],
    nodeModulesAbi: values['node-modules-abi'],
    entrypoints: values.entrypoint ?? [],
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  writeManifestFile(resolve(values.root), manifest, values['manifest-file'] ?? DEFAULT_MANIFEST_FILE)
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

function runVerifyCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      'manifest-file': { type: 'string' },
      platform: { type: 'string' },
      arch: { type: 'string' },
      product: { type: 'string' },
      'package-version': { type: 'string' },
      'node-version': { type: 'string' },
    },
  })
  const manifest = verifyPayload({
    root: resolve(values.root),
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
    expect: {
      platform: values.platform,
      arch: values.arch,
      product: values.product,
      packageVersion: values['package-version'],
      nodeVersion: values['node-version'],
    },
  })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

function runInstallCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'payload-root': { type: 'string' },
      'runtime-root': { type: 'string' },
      'manifest-file': { type: 'string' },
      platform: { type: 'string' },
      arch: { type: 'string' },
      product: { type: 'string' },
      'package-version': { type: 'string' },
      'node-version': { type: 'string' },
    },
  })
  const result = installRuntime({
    payloadRoot: resolve(values['payload-root']),
    runtimeRoot: resolve(values['runtime-root']),
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
    expect: {
      platform: values.platform,
      arch: values.arch,
      product: values.product,
      packageVersion: values['package-version'],
      nodeVersion: values['node-version'],
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runPruneCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-root': { type: 'string' },
      'runtime-id': { type: 'string' },
      'manifest-file': { type: 'string' },
    },
  })
  const result = pruneRuntime({
    runtimeRoot: resolve(values['runtime-root']),
    runtimeId: values['runtime-id'],
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runListCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-root': { type: 'string' },
      'manifest-file': { type: 'string' },
    },
  })
  const result = listRuntimes({
    runtimeRoot: resolve(values['runtime-root']),
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function main(argv) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'manifest': runManifestCmd(rest); break
      case 'verify': runVerifyCmd(rest); break
      case 'install': runInstallCmd(rest); break
      case 'prune': runPruneCmd(rest); break
      case 'list': runListCmd(rest); break
      default:
        process.stderr.write(
          'usage: runtime-payload.mjs <manifest|verify|install|prune|list> [flags]\n',
        )
        process.exitCode = 2
    }
  } catch (err) {
    process.stderr.write(`runtime-payload: ${err.message}\n`)
    process.exitCode = 1
  }
}

/**
 * Is `moduleUrl` (an `import.meta.url`-style file: URL) the script Node was
 * actually invoked to run? A naive `fileURLToPath(import.meta.url) ===
 * resolve(process.argv[1])` breaks whenever exactly one side of that
 * comparison has been canonicalized through a symlinked ancestor directory
 * and the other has not — which is the common case on macOS, where every
 * path under `/var` (including `os.tmpdir()`, i.e. every staged/installed
 * runtime) is itself a symlink to `/private/var`. Node's ESM loader
 * resolves `import.meta.url` to the real (symlink-free) path, while
 * `process.argv[1]` is left exactly as the caller typed it — so an
 * installed helper invoked as `/var/.../dist/runtime-payload.mjs` would
 * silently fail this check, take the "imported as a library" branch, run
 * no CLI action, and exit 0 as if nothing were wrong. Comparing both sides
 * through `realpathSync` (with a safe fallback to the un-resolved path if
 * `realpathSync` itself fails, e.g. a still-just-created file) also makes
 * this correct for a caller that reaches the script through a symlinked
 * alias (a wrapper `bin/` shim, a package symlink, etc.), not only for a
 * symlinked ancestor directory.
 */
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false
  let scriptPath
  try {
    scriptPath = fileURLToPath(moduleUrl)
  } catch {
    return false
  }
  const argvPath = resolve(process.argv[1])
  if (scriptPath === argvPath) return true

  const canonical = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return canonical(scriptPath) === canonical(argvPath)
}

const isMain = isMainModule(import.meta.url)
if (isMain) {
  main(process.argv.slice(2))
}
