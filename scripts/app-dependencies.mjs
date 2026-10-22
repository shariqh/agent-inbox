// Install a staged Electron app's production dependencies and compile
// better-sqlite3 for Electron from the lockfile-pinned source (#315).
//
// better-sqlite3's install script is `prebuild-install || node-gyp rebuild`, and
// @electron/rebuild runs prebuild-install before compiling unless told
// otherwise. prebuild-install unpacks <npm cache>/_prebuilds/<asset> when it
// exists, else downloads the release asset, and checks no digest either way.
// Every entry of that archive lands in the package, JavaScript included, so a
// cached or downloaded prebuild could put an addon, or code, into a signed app
// that this build never compiled, and no later gate would notice.
//
// `npm ci --ignore-scripts` keeps the install script from running
// (better-sqlite3 is the only production package with one), and
// `buildFromSource` sends @electron/rebuild straight to node-gyp.
import { execFileSync } from 'node:child_process'
import { rebuild } from '@electron/rebuild'

export async function installAppDependencies({
  stageRoot,
  npmCli,
  electronVersion,
  arch,
  env = process.env,
}) {
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  })
  await rebuild({
    buildPath: stageRoot,
    electronVersion,
    arch,
    force: true,
    onlyModules: ['better-sqlite3'],
    buildFromSource: true,
  })
}
