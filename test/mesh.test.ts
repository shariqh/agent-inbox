// Mesh M1 (#397): mesh.json and meshctl. Design:
// docs/superpowers/specs/2026-10-29-agent-mesh-design.md §2, amended by #454
// (2026-11-04-agents-home-design.md §4): the Agents view is always on, the
// viewer no longer watches mesh.json and /api/version never carries `mesh`.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { MESH_FILE_MAX, meshDir, meshFile, parseMesh } from '../src/mesh-config.js'
import { runMeshctl } from '../src/meshctl.js'
import type { MeshctlIo } from '../src/meshctl.js'
import { createViewer } from '../src/viewer.js'
import { openDb } from '../src/store.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

const REPO = new URL('..', import.meta.url).pathname

function ctl(argv: string[], dir: string, now = new Date(2026, 9, 29, 11, 48, 30), extra: Partial<MeshctlIo> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = runMeshctl(argv, {
    env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', now: () => now,
    out: (text) => out.push(text), err: (text) => err.push(text), ...extra,
  })
  return { code, out: out.join(''), err: err.join('') }
}

describe('where mesh.json lives', () => {
  it('prefers AGENT_INBOX_MESH_DIR, then the AGENT_INBOX_DB folder, then ~/.agent-inbox', () => {
    expect(meshDir({ AGENT_INBOX_MESH_DIR: '/m', AGENT_INBOX_DB: '/d/inbox.db' }, '/h')).toBe('/m')
    expect(meshDir({ AGENT_INBOX_MESH_DIR: 'relative', AGENT_INBOX_DB: '/d/inbox.db' }, '/h')).toBe('/d')
    expect(meshDir({}, '/h')).toBe('/h/.agent-inbox')
    expect(meshFile('/m')).toBe('/m/mesh.json')
  })
})

describe('parseMesh', () => {
  it('accepts schema 1 objects and refuses everything else with a fixed reason', () => {
    expect(parseMesh('{"schema":1,"agentsView":true,"x":{"y":1}}')).toEqual({ ok: true, doc: { schema: 1, agentsView: true, x: { y: 1 } } })
    expect(parseMesh('{"schema":1')).toEqual({ ok: false, reason: 'not-json' })
    expect(parseMesh('[1]')).toEqual({ ok: false, reason: 'not-object' })
    expect(parseMesh('{"agentsView":true}')).toEqual({ ok: false, reason: 'no-schema' })
    expect(parseMesh('{"schema":2,"agentsView":true}')).toEqual({ ok: false, reason: 'newer-schema' })
    expect(parseMesh(`{"schema":1,"pad":"${'x'.repeat(MESH_FILE_MAX)}"}`)).toEqual({ ok: false, reason: 'too-large' })
  })
})

describe('meshctl', () => {
  it('enable --agents-view writes nothing, with or without --apply: the view is always on (#454)', () => {
    const dir = scratchDir('meshctl-')
    for (const argv of [['enable', '--agents-view'], ['enable', '--agents-view', '--apply']]) {
      const r = ctl(argv, dir)
      expect(r.code).toBe(0)
      expect(r.out).toBe('The Agents view is always on; mesh.json no longer controls it. Nothing written.\n')
      expect(readdirSync(dir)).toEqual([])
    }
    // an existing file, agentsView key included, is left exactly as it is
    const before = '{"schema":1,"agentsView":true,"console":{"relay":false}}\n'
    writeFileSync(meshFile(dir), before)
    expect(ctl(['enable', '--agents-view', '--apply'], dir).code).toBe(0)
    expect(readFileSync(meshFile(dir), 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['mesh.json'])
  })

  it('refuses a symlink, a newer schema and an unreadable file, changing nothing', () => {
    const dir = scratchDir('meshctl-')
    writeFileSync(join(dir, 'real.json'), '{"schema":1}')
    symlinkSync(join(dir, 'real.json'), meshFile(dir))
    for (const argv of [['disable', '--apply']]) {
      const r = ctl(argv, dir)
      expect(r.code).toBe(1)
      expect(r.err).toContain('not a regular file')
    }
    expect(ctl(['status'], dir).out).toContain('is not a regular file')
    expect(lstatSync(meshFile(dir)).isSymbolicLink()).toBe(true)

    const newer = scratchDir('meshctl-')
    writeFileSync(meshFile(newer), '{"schema":2,"agentsView":true}')
    expect(ctl(['status'], newer).out).toContain('newer Agent Inbox')
    expect(ctl(['disable', '--apply'], newer).code).toBe(1)
    expect(readFileSync(meshFile(newer), 'utf8')).toBe('{"schema":2,"agentsView":true}')

    const broken = scratchDir('meshctl-')
    writeFileSync(meshFile(broken), '{"schema":1, "token":"sk-secret"')
    const r = ctl(['disable', '--apply'], broken)
    expect(r.err).toContain('is not valid JSON')
    expect(r.err).not.toContain('sk-secret')
    expect(ctl(['status'], broken).out).not.toContain('sk-secret')
  })

  it('disable is a dry run, then removes the file and keeps a backup', () => {
    const dir = scratchDir('meshctl-')
    writeFileSync(meshFile(dir), '{"schema":1,"agentsView":true}\n')
    const dry = ctl(['disable'], dir)
    expect(dry.out).toContain('Would delete')
    expect(readdirSync(dir)).toEqual(['mesh.json'])
    const r = ctl(['disable', '--apply'], dir)
    expect(r.code).toBe(0)
    expect(readdirSync(dir)).toEqual(['mesh.json.bak-20261029T114830'])
    expect(ctl(['disable', '--apply'], dir).out).toContain('already off')
  })

  it('status says the view is always on and what the file turns on; bad arguments are usage errors', () => {
    const dir = scratchDir('meshctl-')
    expect(ctl(['status'], dir).out).toBe([
      'The Agents view is always on; mesh.json no longer controls it.',
      `Mesh: off. No ${meshFile(dir)}.`,
      `Unslop: off. Profile ${dir}/mesh/wrappers/unslop.json: missing; token: missing; shim ${dir}/bin/unslop: missing.`, '',
    ].join('\n'))
    writeFileSync(meshFile(dir), '{"schema":1,"agentsView":true}\n')
    expect(ctl(['status'], dir).out).toContain('turns on no piece this build reads')
    for (const argv of [[], ['enable'], ['enable', '--agents-view', '--bogus'], ['status', '--apply'], ['nope'],
      ['disable', '--purge'], ['status', '--unslop'], ['enable', '--unslop', '--agents-view'], ['enable', '--unslop', '--port']]) {
      expect(ctl(argv, dir).code, argv.join(' ')).toBe(2)
    }
  })
})

describe('meshctl enable/disable --unslop (#483, unslop design §4.2-§4.5)', () => {
  // a checkout with packages/mesh built, and a stand-in meshctl.js the shim runs
  function setup(meshJson?: string) {
    const dir = scratchDir('unslop-mesh-')
    const checkout = scratchDir('unslop-checkout-')
    mkdirSync(join(checkout, 'packages', 'mesh', 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'packages', 'mesh', 'package.json'), '{}')
    writeFileSync(join(checkout, 'packages', 'mesh', 'dist', 'wrap.js'), '')
    const script = join(scratchDir('unslop-bin-'), 'meshctl.js')
    writeFileSync(script, 'console.log(JSON.stringify([process.env.AGENT_INBOX_MESH_DIR, ...process.argv.slice(2)]))\n')
    if (meshJson !== undefined) writeFileSync(meshFile(dir), meshJson)
    const io = { node: process.execPath, script }
    const run = (...argv: string[]) => ctl(argv, dir, undefined, io)
    return { dir, checkout, script, run, enable: (...more: string[]) => run('enable', '--unslop', '--checkout', checkout, ...more) }
  }
  // every path under dir with its mode, and file contents
  function tree(dir: string, base = dir): Record<string, string> {
    const found: Record<string, string> = {}
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      const stat = lstatSync(path)
      const key = path.slice(base.length + 1)
      const mode = (stat.mode & 0o777).toString(8)
      if (stat.isDirectory()) Object.assign(found, { [key]: `dir ${mode}` }, tree(path, base))
      else found[key] = `${mode} ${readFileSync(path, 'utf8')}`
    }
    return found
  }
  const mode = (path: string): string => (lstatSync(path).mode & 0o777).toString(8)
  const json = (dir: string) => JSON.parse(readFileSync(meshFile(dir), 'utf8'))

  it('enable is a dry run that writes nothing and prints what it would write', () => {
    const fresh = setup()
    const r = fresh.enable()
    expect(r.code).toBe(0)
    expect(r.out).toContain('"endpoint": "http://127.0.0.1:4420"')
    expect(r.out).toContain('"skill": "FILL IN:')
    expect(r.out).toContain(`exec "$node" "$meshctl" unslop "$@"`)
    expect(r.out).toContain('Nothing changed. Re-run with --apply.')
    expect(readdirSync(fresh.dir)).toEqual([])
    const kept = setup('{"schema":1,"console":{"relay":false}}\n')
    expect(kept.enable('--port', '4500').out).toContain('"endpoint": "http://127.0.0.1:4500"')
    expect(readdirSync(kept.dir)).toEqual(['mesh.json'])
    expect(kept.run('disable', '--unslop', '--purge').out).toContain('already off and purged')
  })

  it('(g) enable --apply then disable --apply leaves the other keys and the tree as before, but backups and the profile', () => {
    for (const before of ['{"schema":1,"agentsView":true,"console":{"relay":false},"agents":{"other":{"endpoint":"x"}}}\n', undefined]) {
      const t = setup(before)
      const start = tree(t.dir)
      const on = t.enable('--apply')
      expect(on.code, on.err).toBe(0)
      const p = (rel: string) => join(t.dir, rel)
      expect(json(t.dir)).toEqual({ ...(before ? JSON.parse(before) : { schema: 1 }), agents: { ...(before ? { other: { endpoint: 'x' } } : {}), unslop: { endpoint: 'http://127.0.0.1:4420', profile: 'unslop' } } })
      for (const d of ['mesh', 'mesh/wrappers', 'mesh/tokens', 'bin']) expect(mode(p(d)), d).toBe('700')
      expect(mode(p('mesh/wrappers/unslop.json'))).toBe('600')
      expect(mode(p('mesh/tokens/unslop'))).toBe('600')
      expect(mode(p('bin/unslop'))).toBe('755')
      expect(readFileSync(p('mesh/tokens/unslop'), 'utf8')).toMatch(/^[\x21-\x7E]{32,}\n$/)
      const profile = JSON.parse(readFileSync(p('mesh/wrappers/unslop.json'), 'utf8'))
      expect(profile.start).toEqual([process.execPath, join(t.checkout, 'packages/mesh/dist/wrap.js'), '--agent', 'openai-compatible', '--profile', 'unslop'])
      expect(t.run('status').out).toContain('Unslop: on at http://127.0.0.1:4420. Profile')
      // the live shim execs meshctl.js unslop with the caller's arguments
      const shim = spawnSync('/bin/sh', [p('bin/unslop'), '--kind', 'pr'], { input: 'text', encoding: 'utf8' })
      expect(shim.stdout).toBe(`${JSON.stringify([t.dir, 'unslop', '--kind', 'pr'])}\n`)
      // the shim pins its mesh dir: an empty environment (env -i), or a caller's other mesh dir or hub, cannot move it
      for (const env of [[], ['AGENT_INBOX_MESH_DIR=/elsewhere'], ['AGENT_INBOX_DB=/elsewhere/inbox.db']]) {
        const pinned = spawnSync('/usr/bin/env', ['-i', ...env, '/bin/sh', p('bin/unslop')], { input: '', encoding: 'utf8' })
        expect(pinned.stdout, env.join(' ')).toBe(`${JSON.stringify([t.dir, 'unslop'])}\n`)
      }

      const off = t.run('disable', '--unslop', '--apply')
      expect(off.code, off.err).toBe(0)
      const after = tree(t.dir)
      for (const key of Object.keys(after)) if (key.startsWith('mesh.json.bak-')) delete after[key]
      expect(Object.keys(after).filter((key) => key.startsWith('mesh')).sort())
        .toEqual([...(before ? ['mesh.json'] : []), 'mesh', 'mesh/wrappers', 'mesh/wrappers/unslop.json'].sort())
      for (const key of ['mesh', 'mesh/wrappers', 'mesh/wrappers/unslop.json']) delete after[key]
      if (before) {
        expect(json(t.dir)).toEqual(JSON.parse(before))
        delete after['mesh.json']
        delete start['mesh.json']
      }
      expect(after).toEqual(start)
      expect(t.run('status').out).toContain('Unslop: off. Profile')
    }
  })

  it('refuses any port but 1-65535 other than 80, so the endpoint is only http://127.0.0.1:<port>', () => {
    const t = setup('{"schema":1}\n')
    for (const port of ['80', '0', '65536', '0.0.0.0:4420', 'http://192.168.1.2:4420', '-1', '']) {
      const r = t.enable('--port', port, '--apply')
      expect(r.code, port).toBe(1)
      expect(r.err).toContain('http://127.0.0.1:<port>')
    }
    expect(readdirSync(t.dir)).toEqual(['mesh.json'])
    writeFileSync(meshFile(t.dir), '{"schema":1,"agents":{"unslop":{"endpoint":"http://0.0.0.0:4420"}}}')
    expect(t.run('status').out).toContain('Unslop: off (agents.unslop.endpoint is not http://127.0.0.1:<port>)')
    expect(t.enable('--port', '4421', '--apply').code).toBe(0)
    expect(json(t.dir).agents.unslop.endpoint).toBe('http://127.0.0.1:4421')
  })

  it('never overwrites a profile or token, and refuses a symlinked or newer mesh.json, a missing build or a non-checkout', () => {
    const t = setup()
    mkdirSync(join(t.dir, 'mesh', 'wrappers'), { recursive: true })
    mkdirSync(join(t.dir, 'mesh', 'tokens'), { recursive: true })
    writeFileSync(join(t.dir, 'mesh', 'wrappers', 'unslop.json'), '{"mine":true}')
    writeFileSync(join(t.dir, 'mesh', 'tokens', 'unslop'), 'my-token')
    const r = t.enable('--apply')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Kept')
    expect(readFileSync(join(t.dir, 'mesh', 'wrappers', 'unslop.json'), 'utf8')).toBe('{"mine":true}')
    expect(readFileSync(join(t.dir, 'mesh', 'tokens', 'unslop'), 'utf8')).toBe('my-token')
    expect(t.enable('--apply').out).toContain('Kept mesh.json'.replace('mesh.json', meshFile(t.dir)))

    const link = setup()
    writeFileSync(join(link.dir, 'real.json'), '{"schema":1}')
    symlinkSync(join(link.dir, 'real.json'), meshFile(link.dir))
    const newer = setup('{"schema":2}')
    for (const [s, words] of [[link, 'not a regular file'], [newer, 'newer Agent Inbox']] as const) {
      for (const argv of [['enable', '--unslop', '--checkout', s.checkout, '--apply'], ['disable', '--unslop', '--purge', '--apply']]) {
        const refused = s.run(...argv)
        expect(refused.code).toBe(1)
        expect(refused.err).toContain(words)
      }
      expect(existsSync(join(s.dir, 'mesh'))).toBe(false)
    }
    expect(lstatSync(meshFile(link.dir)).isSymbolicLink()).toBe(true)
    expect(readFileSync(meshFile(newer.dir), 'utf8')).toBe('{"schema":2}')

    const unbuilt = setup()
    expect(unbuilt.run('enable', '--unslop', '--checkout', unbuilt.dir, '--apply').err).toContain('is not an agent-inbox checkout: pass --checkout')
    unlinkSync(join(unbuilt.checkout, 'packages', 'mesh', 'dist', 'wrap.js'))
    expect(unbuilt.enable('--apply').err).toContain('dist/wrap.js is missing: run npm ci && npm run build in')
    expect(readdirSync(unbuilt.dir)).toEqual([])
  })

  it('--purge also removes the profile, unslop logs, deny list and budget', () => {
    const t = setup()
    expect(t.enable('--apply').code).toBe(0)
    const root = join(t.dir, 'mesh')
    mkdirSync(join(root, 'logs'))
    for (const f of ['logs/unslop-2026-11-06.log', 'logs/other.log', 'unslop-deny.txt', 'unslop-budget.json']) writeFileSync(join(root, f), 'x')
    expect(t.run('disable', '--unslop', '--apply').code).toBe(0)
    expect(existsSync(join(root, 'unslop-deny.txt'))).toBe(true)
    expect(t.run('disable', '--unslop', '--purge', '--apply').code).toBe(0)
    const left = tree(t.dir)
    for (const key of Object.keys(left)) if (key.startsWith('mesh.json.bak-')) delete left[key]
    expect(left).toEqual({ mesh: 'dir 700', 'mesh/logs': expect.stringMatching(/^dir /), 'mesh/logs/other.log': expect.stringMatching(/ x$/) })
  })

  it('a stale shim reads and discards its input and exits 14; meshctl unslop is not built yet (14)', () => {
    // the shim names a Node binary and a meshctl.js that later go away (a new runtime, a moved checkout)
    for (const gone of ['node', 'script'] as const) {
      const t = setup()
      const node = join(scratchDir('unslop-node-'), 'node')
      writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 })
      expect(ctl(['enable', '--unslop', '--checkout', t.checkout, '--apply'], t.dir, undefined, { node, script: t.script }).code).toBe(0)
      const shim = join(t.dir, 'bin', 'unslop')
      expect(spawnSync('/bin/sh', [shim], { input: '', encoding: 'utf8' }).stdout).toBe(`${JSON.stringify([t.dir, 'unslop'])}\n`)
      unlinkSync(gone === 'node' ? node : t.script)
      const r = spawnSync('/bin/sh', [shim, '--kind', 'pr'], { input: 'x'.repeat(1 << 20), encoding: 'utf8' })
      expect(r.error, gone).toBeUndefined()
      expect(r.status).toBe(14)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('run meshctl enable --unslop again')
    }
    const r = ctl(['unslop', '--kind', 'pr'], scratchDir('unslop-mesh-'))
    expect([r.code, r.out]).toEqual([14, ''])
    expect(r.err).toContain('not built yet')
  })

  // (e), the agent's own gate, is tested in packages/mesh/test/a2a.test.ts; here the
  // template is run through the agent itself, which refuses each placeholder in turn
  it('the agent refuses the profile template until it is filled in', () => {
    const t = setup()
    expect(t.enable('--apply').code).toBe(0)
    const profile = join(t.dir, 'mesh', 'wrappers', 'unslop.json')
    const wrap = () => spawnSync(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'packages', 'mesh', 'src', 'wrap.ts'), '--agent', 'openai-compatible', '--profile', 'unslop'],
      { env: { PATH: process.env['PATH'], AGENT_INBOX_MESH_DIR: t.dir }, encoding: 'utf8', timeout: 30_000 })
    for (const [fill, words] of [[{}, 'needs an absolute `skill` folder'], [{ skill: t.dir }, 'base URL is not a URL'], [{ skill: t.dir, baseUrl: 'https://box.example' }, 'API key source is empty']] as const) {
      writeFileSync(profile, JSON.stringify({ ...JSON.parse(readFileSync(profile, 'utf8')), ...fill }))
      const r = wrap()
      expect([r.status, r.stderr]).toEqual([1, `agent-inbox-wrap: the ${words.startsWith('needs') ? 'profile ' : words.startsWith('base') ? 'backend ' : ''}${words}\n`])
    }
  }, 60_000)
})

describe('no new dependency (design §2.3, §2.4c)', () => {
  const MESH_FILES = ['src/mesh-config.ts', 'src/meshctl.ts', 'public/agents-home.js']
  const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g
  // comment lines name modules in prose; only code imports count
  const code = (file: string): string => readFileSync(join(REPO, file), 'utf8').split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')

  it('mesh modules import only Node core and the app’s own modules, never the hub', () => {
    for (const file of MESH_FILES) {
      const specs = [...code(file).matchAll(SPECIFIERS)].map((m) => m[2]!)
      expect(specs.length, file).toBeGreaterThan(0)
      for (const spec of specs) expect(spec, `${file} imports ${spec}`).toMatch(/^(node:|\.\/)/)
      expect(specs, `${file} must not open the hub`).not.toContain('./store.js')
    }
    // meshctl and the config module are Node core plus each other only
    const ctlSpecs = [...code('src/meshctl.ts').matchAll(SPECIFIERS)].map((m) => m[2]!)
    expect(ctlSpecs.filter((spec) => !spec.startsWith('node:'))).toEqual(['./mesh-config.js', './mesh-config.js'])
  })

  // The app's whole dependency set, pinned by name: package.json's dependencies and
  // devDependencies and every package path in the lockfile. A version bump changes
  // none of these; a new package (direct or transitive) changes one and fails here.
  const DEPENDENCY_FIXTURE = new URL('./fixtures/app-dependencies.txt', import.meta.url)
  function dependencySet(): string {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'))
    const names = (deps: Record<string, string> | undefined) => Object.keys(deps ?? {}).sort()
    return [
      '# dependencies', ...names(pkg.dependencies),
      '# devDependencies', ...names(pkg.devDependencies),
      '# package-lock.json packages', ...Object.keys(lock.packages).filter((key) => key !== '').sort(),
    ].join('\n') + '\n'
  }

  it('the dependency set is exactly the pinned one', () => {
    if (process.env['AGENT_INBOX_UPDATE_DEPENDENCY_FIXTURE'] === '1') writeFileSync(DEPENDENCY_FIXTURE, dependencySet())
    expect(dependencySet(), [
      'The app\'s dependency set changed (package.json or package-lock.json gained or lost a package).',
      'The mesh may never add one (design §2.4c). If this change is a deliberate dependency change',
      'outside the mesh, review it and refresh the pin with:',
      '  AGENT_INBOX_UPDATE_DEPENDENCY_FIXTURE=1 npx vitest run test/mesh.test.ts -t "dependency set"',
      'and commit test/fixtures/app-dependencies.txt with it.',
    ].join('\n')).toBe(readFileSync(DEPENDENCY_FIXTURE, 'utf8'))
  })

  it('the lockfile root declares exactly package.json’s dependencies and only meshctl’s bin is new', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'))
    const root = lock.packages['']
    expect(root.dependencies).toEqual(pkg.dependencies)
    expect(root.devDependencies).toEqual(pkg.devDependencies)
    // npm's lockfile v3 records the root bin map; meshctl's entry is the only mesh change there
    expect(root.bin).toEqual(Object.fromEntries(Object.entries(pkg.bin as Record<string, string>).map(([k, v]) => [k, v.replace(/^\.\//, '')])))
    expect(root.bin['agent-inbox-meshctl']).toBe('dist/meshctl.js')
  })
})

describe('/api/version never carries mesh (#454 §4)', () => {
  it('has no mesh key, whatever mesh.json says', async () => {
    const dbDir = scratchDir('mesh-viewer-')
    writeFileSync(join(dbDir, 'mesh.json'), '{"schema":1,"agentsView":true}\n')
    const db = openDb(join(dbDir, 'inbox.db'))
    const home = scratchDir('mesh-home-')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const res = await createViewer(db, { agentHome: home, setupInfoPath: join(dbDir, 'none.json') }).request('/api/version')
    expect(Object.keys(await res.json())).toEqual(['current', 'mode', 'runtimeInstalled', 'updatable', 'hosts'])
    db.close()
  })
})
