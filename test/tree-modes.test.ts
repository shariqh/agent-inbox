import { chmodSync, lchmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeTreeModes, UnsafeTreeModeError } from '../scripts/tree-modes.mjs'
import { LinuxThinVerificationError, verifyLinuxThinApp } from '../scripts/verify-linux-thin-app.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(removeScratchDirs)

const root = resolve(process.cwd())

function file(path: string, mode: number, content = 'x'): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

function dir(path: string, mode = 0o755): string {
  mkdirSync(path, { recursive: true })
  chmodSync(path, mode)
  return path
}

// A non-root chmod can drop a special bit silently (setgid for a group the user is not in).
function setMode(path: string, mode: number): boolean {
  chmodSync(path, mode)
  return (statSync(path).mode & 0o7777) === mode
}

function modeError(fn: () => void): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return ''
}

function linuxApp(): string {
  const app = dir(join(scratchDir('tree-modes-linux-'), 'Agent Inbox'))
  file(join(app, 'agent-inbox'), 0o755)
  file(join(app, 'chrome-sandbox'), 0o755)
  file(join(app, 'resources.pak'), 0o644)
  dir(join(app, 'locales'))
  file(join(app, 'locales', 'en-US.pak'), 0o644)
  dir(join(app, 'resources', 'app', 'dist'))
  file(join(app, 'resources', 'app', 'dist', 'store.js'), 0o644)
  symlinkSync('agent-inbox', join(app, 'link'))
  return app
}

function macApp(): string {
  const app = dir(join(scratchDir('tree-modes-macos-'), 'Agent Inbox.app'))
  const contents = join(app, 'Contents')
  file(join(contents, 'Info.plist'), 0o644)
  file(join(contents, 'MacOS', 'Agent Inbox'), 0o755)
  file(join(contents, '_CodeSignature', 'CodeResources'), 0o644)
  const framework = join(contents, 'Frameworks', 'Electron Framework.framework')
  file(join(framework, 'Versions', 'A', 'Electron Framework'), 0o755)
  file(join(framework, 'Versions', 'A', '_CodeSignature', 'CodeResources'), 0o644)
  symlinkSync('A', join(framework, 'Versions', 'Current'))
  symlinkSync('Versions/Current/Electron Framework', join(framework, 'Electron Framework'))
  const helper = join(contents, 'Frameworks', 'Agent Inbox Helper.app', 'Contents')
  file(join(helper, 'MacOS', 'Agent Inbox Helper'), 0o755)
  file(join(helper, '_CodeSignature', 'CodeResources'), 0o644)
  file(join(contents, 'Resources', 'app', 'runtime', 'darwin-arm64', 'bin', 'node'), 0o755)
  return app
}

describe('assertSafeTreeModes (#378)', () => {
  it('accepts a 0644/0755 tree and never judges or follows a symlink', () => {
    const app = linuxApp()
    const outside = file(join(app, '..', 'outside'), 0o666)
    symlinkSync(outside, join(app, 'outside-link'))
    // Links are 0777 on Linux; only macOS lets lchmod give one write bits.
    if (process.platform === 'darwin' && typeof lchmodSync === 'function') lchmodSync(join(app, 'link'), 0o777)
    expect(() => assertSafeTreeModes(app, { label: 'app' })).not.toThrow()
  })

  it('refuses a world-writable file, naming its path and mode', () => {
    const app = linuxApp()
    chmodSync(join(app, 'resources.pak'), 0o666)
    const message = modeError(() => assertSafeTreeModes(app, { label: 'packaged app' }))
    expect(message).toBe('packaged app has 1 unsafe file mode(s): resources.pak 0666 (group/other-writable)')
  })

  it('refuses a group-writable directory, the root included', () => {
    const app = linuxApp()
    chmodSync(join(app, 'locales'), 0o775)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app' })))
      .toContain('locales 0775 (group/other-writable)')
    chmodSync(join(app, 'locales'), 0o755)
    chmodSync(app, 0o775)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app' }))).toContain(': . 0775 (group/other-writable)')
  })

  it('refuses setuid, setgid and sticky bits', () => {
    const app = linuxApp()
    chmodSync(join(app, 'agent-inbox'), 0o4755)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app' })))
      .toContain('agent-inbox 4755 (setuid/setgid/sticky)')
    chmodSync(join(app, 'agent-inbox'), 0o755)
    if (setMode(join(app, 'resources.pak'), 0o2644)) {
      expect(modeError(() => assertSafeTreeModes(app, { label: 'app' })))
        .toContain('resources.pak 2644 (setuid/setgid/sticky)')
    }
    chmodSync(join(app, 'resources.pak'), 0o644)
    chmodSync(join(app, 'locales'), 0o1755)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app' })))
      .toContain('locales 1755 (setuid/setgid/sticky)')
  })

  it('allows a special bit only on the named regular file, at exactly the allowed mode', () => {
    const app = linuxApp()
    const privileged = { 'chrome-sandbox': [0o4755] }
    chmodSync(join(app, 'chrome-sandbox'), 0o4755)
    expect(() => assertSafeTreeModes(app, { label: 'app', privileged })).not.toThrow()
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app' })))
      .toContain('chrome-sandbox 4755 (setuid/setgid/sticky)')
    chmodSync(join(app, 'chrome-sandbox'), 0o4775)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app', privileged })))
      .toContain('chrome-sandbox 4775 (group/other-writable, setuid/setgid/sticky)')
    chmodSync(join(app, 'chrome-sandbox'), 0o755)
    chmodSync(join(app, 'agent-inbox'), 0o4755)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'app', privileged })))
      .toContain('agent-inbox 4755 (setuid/setgid/sticky)')
  })

  it('lists at most ten offenders and counts the rest', () => {
    const app = linuxApp()
    for (let i = 0; i < 12; i += 1) file(join(app, 'locales', `x${String(i).padStart(2, '0')}.pak`), 0o666)
    const message = modeError(() => assertSafeTreeModes(app, { label: 'app' }))
    expect(message).toMatch(/^app has 12 unsafe file mode\(s\): /)
    expect(message).toContain('locales/x09.pak 0666')
    expect(message).not.toContain('locales/x10.pak')
    expect(message).toMatch(/; and 2 more$/)
    expect(() => assertSafeTreeModes(app, { label: 'app' })).toThrow(UnsafeTreeModeError)
  })
})

describe('Linux thin-folder mode gate (#378)', () => {
  // The gate runs first, so a tree it accepts fails later on something it lacks.
  function verify(app: string, extractedPackage?: boolean): string {
    return modeError(() => verifyLinuxThinApp({ app, arch: 'x64', ...(extractedPackage ? { extractedPackage } : {}) }))
  }

  it('accepts chrome-sandbox at 0755 in a thin folder and refuses it setuid there', () => {
    const app = linuxApp()
    expect(verify(app)).not.toMatch(/unsafe file mode/)
    chmodSync(join(app, 'chrome-sandbox'), 0o4755)
    expect(verify(app)).toBe(
      'packaged Linux app has 1 unsafe file mode(s): chrome-sandbox 4755 (setuid/setgid/sticky)',
    )
    expect(() => verifyLinuxThinApp({ app, arch: 'x64' })).toThrow(LinuxThinVerificationError)
  })

  it("accepts chrome-sandbox at 04755 or 0755 in a package's extracted inner app, and nothing else setuid", () => {
    const app = linuxApp()
    expect(verify(app, true)).not.toMatch(/unsafe file mode/)
    chmodSync(join(app, 'chrome-sandbox'), 0o4755)
    expect(verify(app, true)).not.toMatch(/unsafe file mode/)
    chmodSync(join(app, 'agent-inbox'), 0o4755)
    expect(verify(app, true)).toContain("a Linux package's inner app has 1 unsafe file mode(s): agent-inbox 4755")
    chmodSync(join(app, 'agent-inbox'), 0o755)
    chmodSync(join(app, 'resources.pak'), 0o664)
    expect(verify(app, true)).toContain('resources.pak 0664 (group/other-writable)')
  })

  it('is told which context it checks by every caller', () => {
    const source = (name: string) => readFileSync(join(root, 'scripts', name), 'utf8')
    for (const name of ['verify-linux-appimage.mjs', 'verify-linux-deb.mjs']) {
      expect(source(name).match(/extractedPackage: true,/g), name).toHaveLength(1)
    }
    for (const name of ['build-linux-thin-app.mjs', 'build-linux-appimage.mjs', 'build-linux-deb.mjs']) {
      expect(source(name), name).not.toContain('extractedPackage')
    }
    const verifier = source('verify-linux-thin-app.mjs')
    expect(verifier.indexOf('assertLinuxTreeModes(appRoot, extractedPackage)'))
      .toBeLessThan(verifier.indexOf('assertElectronNotices(appRoot)'))
  })
})

describe('macOS thin-app mode gate (#378)', () => {
  it('accepts a signed bundle shape: _CodeSignature, framework links and helper apps', () => {
    expect(() => assertSafeTreeModes(macApp(), { label: 'signed macOS app' })).not.toThrow()
  })

  it('refuses a group-writable signature, an other-writable folder and a setuid helper', () => {
    let app = macApp()
    chmodSync(join(app, 'Contents', '_CodeSignature', 'CodeResources'), 0o664)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'signed macOS app' })))
      .toBe('signed macOS app has 1 unsafe file mode(s): Contents/_CodeSignature/CodeResources 0664 (group/other-writable)')
    app = macApp()
    chmodSync(join(app, 'Contents', 'Resources', 'app', 'runtime'), 0o757)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'copied app' })))
      .toContain('Contents/Resources/app/runtime 0757 (group/other-writable)')
    app = macApp()
    const helper = join(app, 'Contents', 'Frameworks', 'Agent Inbox Helper.app', 'Contents', 'MacOS', 'Agent Inbox Helper')
    chmodSync(helper, 0o4755)
    expect(modeError(() => assertSafeTreeModes(app, { label: 'copied app' })))
      .toContain('Contents/Frameworks/Agent Inbox Helper.app/Contents/MacOS/Agent Inbox Helper 4755 (setuid/setgid/sticky)')
  })

  it('gates the thin app, the signed app and the copied final app', () => {
    const source = (name: string) => readFileSync(join(root, 'scripts', name), 'utf8')
    const thin = source('build-thin-app.mjs')
    const thinGate = thin.indexOf('assertSafeTreeModes(app, { label: `packaged darwin-${arch} app` })')
    expect(thinGate).toBeGreaterThan(thin.indexOf("pruneElectronLocales(app, 'darwin')"))
    expect(thinGate).toBeLessThan(thin.indexOf('runElectronSqliteCheck({'))
    expect(thinGate).toBeLessThan(thin.indexOf('publishAtomically(app, destination, force)'))
    const assemble = source('assemble-macos-release.mjs')
    const signedGate = assemble.indexOf("assertSafeTreeModes(app, { label: 'signed macOS app' })")
    expect(signedGate).toBeGreaterThan(assemble.indexOf("'--verify', '--strict', '--verbose=2', app"))
    expect(signedGate).toBeLessThan(assemble.indexOf('const appTreeDigest = treeIdentity(app)'))
    const gates = source('macos-release-gates.mjs')
    const finalGate = gates.indexOf("assertSafeTreeModes(copiedApp, { label: 'copied app' })")
    expect(finalGate).toBeGreaterThan(gates.indexOf('export async function verifyFinalDmg({'))
    expect(finalGate).toBeLessThan(gates.indexOf('await verifyCopiedAppLaunch({'))
  })
})
