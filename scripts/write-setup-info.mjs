#!/usr/bin/env node
// Write the packaged app's setup-info.json — issue #40's BAKE side.
//
//   node scripts/write-setup-info.mjs <repoRoot> <outFile>
//
// Four facts get baked in, and each answers a question the packaged app cannot
// answer for itself:
//   repoRoot / nodeBin — where agents run the MCP server from (the bundle cannot
//                        host it: its native module is built for Electron's ABI).
//   commit / builtAt   — WHICH BUILD THIS IS. Without them a stale .app looks
//                        exactly like a fresh one, which is how an evening of
//                        testing ran against a bundle four features behind (#40).
//
// Two rules:
//   · If git cannot answer, the `commit` key is ABSENT — never null, never a
//     guess. A wrong commit would make src/stamp.ts claim "up to date" about a
//     build it knows nothing about, which is worse than saying nothing.
//   · Silent on stdout. It runs inside a packaging script whose output the human
//     reads; it has nothing to say unless it fails.
//
// A plain script rather than another `node -e` heredoc inside package-app.sh so
// it can be executed for real by test/package-stamp.test.ts — the packager
// itself never can be.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [repoRoot, outFile] = process.argv.slice(2)
if (!repoRoot || !outFile) {
  console.error('usage: write-setup-info.mjs <repoRoot> <outFile>')
  process.exit(1)
}

// stdio: stdout CAPTURED, stderr and stdin discarded — the same shape as
// src/infer.ts's git(). Nothing git prints may reach the packager's output.
function head(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null
  } catch {
    return null // no git, not a checkout, an empty repo, a timeout
  }
}

const info = { repoRoot, nodeBin: process.execPath, builtAt: new Date().toISOString() }
const commit = head(repoRoot)
if (commit) info.commit = commit

writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`)
