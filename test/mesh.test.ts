// Mesh M1 (#397): mesh.json, meshctl and the Agents lens model. Design:
// docs/superpowers/specs/2026-10-29-agent-mesh-design.md §2, amended by #454
// (2026-11-04-agents-home-design.md §4): the Agents view is always on, the
// viewer no longer watches mesh.json and /api/version never carries `mesh`.
import { afterEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MESH_FILE_MAX, meshDir, meshFile, parseMesh } from '../src/mesh-config.js'
import { runMeshctl } from '../src/meshctl.js'
import { createViewer } from '../src/viewer.js'
import { openDb } from '../src/store.js'
import { agentGroups, sessionRecency } from '../public/agents-home.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

const REPO = new URL('..', import.meta.url).pathname

function ctl(argv: string[], dir: string, now = new Date(2026, 9, 29, 11, 48, 30)) {
  const out: string[] = []
  const err: string[] = []
  const code = runMeshctl(argv, {
    env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', now: () => now,
    out: (text) => out.push(text), err: (text) => err.push(text),
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
    expect(ctl(['status'], dir).out).toBe(`The Agents view is always on; mesh.json no longer controls it.\nMesh: off. No ${meshFile(dir)}.\n`)
    writeFileSync(meshFile(dir), '{"schema":1,"agentsView":true}\n')
    expect(ctl(['status'], dir).out).toContain('turns on no piece this build reads')
    for (const argv of [[], ['enable'], ['enable', '--agents-view', '--bogus'], ['status', '--apply'], ['nope']]) {
      expect(ctl(argv, dir).code, argv.join(' ')).toBe(2)
    }
  })
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

describe('the Agents lens model', () => {
  const NOW = Date.parse('2026-10-29T12:00:00.000Z')
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const minute = Math.floor(NOW / 60_000)
  const row = (o: Record<string, unknown>) => ({ started_at: at(3_600_000), updated_at: at(1000), ...o }) as never

  it('groups by agent, uses the lanes’ working rule and Live’s dormancy, and reads asks', () => {
    const activity = [
      row({ session: 's1', agent: 'copilot', project: 'agent-inbox', stream: 'feat/412', doing: 'Writing tests', last_call_at: at(8000), calls: [2, 3], calls_at: minute }),
      row({ session: 's2', agent: 'copilot', project: 'demo', stream: 'main', doing: 'open', idle: true, last_doing: 'Proofreading', last_call_at: at(47 * 60_000) }),
      row({ session: 's3', agent: 'claude-code', project: 'agent-inbox', stream: 'x', doing: 'Drafting', last_call_at: at(3000), calls: [1], calls_at: minute }),
      row({ session: 's4', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, last_call_at: at(9 * 3_600_000) }),
      // heartbeat only: updated_at is fresh, but no call for 40 minutes is not working
      row({ session: 's5', agent: 'claude-code', project: 'demo', stream: 'b', doing: 'Claims work', last_call_at: at(40 * 60_000), updated_at: at(10) }),
      row({ session: 's6', agent: 'copilot', project: 'closed-one', doing: 'x', last_call_at: at(1000) }),
    ]
    const attention = [
      { kind: 'item', item: { id: 'i1', agent: 'claude-code', created_at: at(5000) } },
      { kind: 'row', row: { id: 'r1', action_agent: 'claude-code', action_started_at: at(4000) }, board: { agent: 'copilot' } },
      { kind: 'row', row: { id: 'r2', action_started_at: at(4000) }, board: { agent: 'copilot' } },
      { kind: 'item', item: { id: 'i2', agent: 'nobody-present', created_at: at(5000) } },
    ]
    const groups = agentGroups({ activity, attention: attention as never, closed: ['closed-one'], nowMs: NOW })
    expect(groups.map((g) => [g.agent, g.sessions.length, g.working, g.asks.length])).toEqual([
      ['claude-code', 3, 1, 2],
      ['copilot', 2, 1, 1],
    ])
    const claude = groups[0]!
    expect(claude.sessions.map((s) => [s.session, s.state])).toEqual([['s3', 'working'], ['s5', 'idle'], ['s4', 'dormant']])
    expect(sessionRecency(claude.sessions[1]!)).toBe('idle 40m')
    const copilot = groups[1]!
    expect(copilot.sessions[0]).toMatchObject({ session: 's1', text: 'Writing tests', historical: false })
    expect(sessionRecency(copilot.sessions[0]!)).toBe('last call just now')
    expect(copilot.sessions[1]).toMatchObject({ session: 's2', text: 'Proofreading', historical: true, state: 'idle' })
    expect(copilot.trace.slice(-2)).toEqual([2, 3])
    expect(claude.trace.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('marks a driven session, and one this app started (#412 step 3)', () => {
    const activity = [
      row({ session: 'd1', agent: 'copilot', project: 'p', doing: 'Working', last_call_at: at(1000), driven: true } as never),
      row({ session: 'd2', agent: 'copilot', project: 'p', doing: 'Working', last_call_at: at(1000), driven: true } as never),
      row({ session: 'plain', agent: 'copilot', project: 'p', doing: 'Working', last_call_at: at(1000) }),
    ]
    const [group] = agentGroups({ activity, attention: [], startedHere: ['d2', 'plain'], nowMs: NOW })
    expect(group!.sessions.map((s) => [s.session, s.driven, s.startedHere])).toEqual([
      ['d1', true, false], ['d2', true, true], ['plain', false, false],
    ])
  })

  it('a working session with no call yet says so', () => {
    const [group] = agentGroups({ activity: [row({ session: 'n', agent: 'copilot', project: 'p', doing: 'Starting', started_at: at(60_000), last_call_at: null })], attention: [], nowMs: NOW })
    expect(sessionRecency(group!.sessions[0]!)).toBe('no call yet')
  })
})
