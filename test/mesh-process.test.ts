// Agent setup in the app, step 2a: electron/mesh-process.cjs, the bridge from the page to the
// person's own meshctl. Every test uses its own temporary folders and fakes; nothing here reads or
// writes the real home's mesh folder, and nothing runs the real meshctl.
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import meshProcess from '../electron/mesh-process.cjs'
import { addedPlace, idRefusal } from '../src/mesh-entry.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { createFileHandles, createMeshBridge, meshAnswer, meshArgv, meshDirOf, meshEnv, readShim, registerMeshIpc, runMeshctl } = meshProcess
const require = createRequire(import.meta.url)
const { createInstallGate } = require('../electron/setup-runner.cjs') as { createInstallGate(): Parameters<typeof createMeshBridge>[0]['gate'] }

const REPO = join(import.meta.dirname, '..')
const UID = process.getuid!()
const MARKER = (kind: string) => `# agent-inbox meshctl shim (#540), kind=${kind}, written by install-agents.sh. Do not edit.`
const KEY_HANDLE = 'a'.repeat(32)
const TOKEN_HANDLE = 'b'.repeat(32)
const PIN = 'f55799f06b5b4117d471de6f7c40cd931bd3bd6aaf93672b071d911d9debd0b3'

afterEach(() => {
  vi.useRealTimers()
  removeScratchDirs()
})

/** A mesh dir in a scratch folder with a node and a script the shim can name. */
function meshFixture(name = 'mesh-') {
  const root = scratchDir(name)
  const dir = join(root, 'mesh dir')
  const home = join(root, 'home')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const node = join(root, 'runtime', 'bin', 'node')
  const script = join(root, 'runtime', 'dist', 'meshctl.js')
  mkdirSync(join(root, 'runtime', 'bin'), { recursive: true })
  mkdirSync(join(root, 'runtime', 'dist'), { recursive: true })
  writeFileSync(node, '')
  chmodSync(node, 0o755)
  writeFileSync(script, '')
  return { root, dir, home, node, script, shim: join(dir, 'bin', 'meshctl') }
}

function shimText(node: string, script: string, kind = 'runtime') {
  return `#!/bin/sh\n${MARKER(kind)}\nnode='${node}'\nmeshctl='${script}'\nif [ ! -x "$node" ] || [ ! -f "$meshctl" ]; then\n  echo 'stale' >&2\n  exit 14\nfi\nexec "$node" "$meshctl" "$@"\n`
}

function writeShim(file: string, text: string, mode = 0o755) {
  writeFileSync(file, text)
  chmodSync(file, mode)
}

describe('readShim: the shim is read, never run', () => {
  it('accepts the installer’s own shim, of either kind, and names its node and script', () => {
    const f = meshFixture()
    // the installer's meshctl_shim_text, run as it is in scripts/install-agents.sh
    const installer = readFileSync(join(REPO, 'scripts', 'install-agents.sh'), 'utf8')
    const quote = installer.slice(installer.indexOf('sh_single_quote() {'), installer.indexOf('\n}\n', installer.indexOf('sh_single_quote() {')) + 3)
    const text = installer.slice(installer.indexOf('meshctl_shim_text() {'), installer.indexOf('\nEOF\n}\n', installer.indexOf('meshctl_shim_text() {')) + 7)
    const marker = installer.split('\n').filter((line) => line.startsWith('MESHCTL_MARKER_'))
    expect(marker).toHaveLength(2)
    for (const kind of ['runtime', 'checkout']) {
      const helper = join(f.root, `shim-${kind}.sh`)
      writeFileSync(helper, `${marker.join('\n')}\n${quote}${text}meshctl_shim_text "$1" "$2" "$3"\n`)
      const made = spawnSync('/bin/bash', [helper, kind, f.node, f.script], { encoding: 'utf8' })
      expect(made.status, made.stderr).toBe(0)
      writeShim(f.shim, `${made.stdout}\n`)
      expect(readShim({ dir: f.dir, uid: UID })).toEqual({ ok: true, node: f.node, script: f.script })
    }
  })

  it('answers not-installed when there is no shim', () => {
    const f = meshFixture()
    expect(readShim({ dir: f.dir, uid: UID })).toEqual({ ok: false, reason: 'not-installed' })
  })

  it('refuses a symlink, a folder, a file writable by others or its group, another owner, and a file over 4 KiB', () => {
    const f = meshFixture()
    const real = join(f.root, 'real-shim')
    writeShim(real, shimText(f.node, f.script))
    symlinkSync(real, f.shim)
    expect(readShim({ dir: f.dir, uid: UID })).toEqual({ ok: false, reason: 'unsafe' })

    const g = meshFixture()
    mkdirSync(g.shim)
    expect(readShim({ dir: g.dir, uid: UID })).toEqual({ ok: false, reason: 'unsafe' })

    for (const mode of [0o775, 0o757, 0o777]) {
      const h = meshFixture()
      writeShim(h.shim, shimText(h.node, h.script), mode)
      expect(readShim({ dir: h.dir, uid: UID }), mode.toString(8)).toEqual({ ok: false, reason: 'unsafe' })
    }

    const owner = meshFixture()
    writeShim(owner.shim, shimText(owner.node, owner.script))
    expect(readShim({ dir: owner.dir, uid: UID })).toMatchObject({ ok: true })
    expect(readShim({ dir: owner.dir, uid: UID + 1 })).toEqual({ ok: false, reason: 'unsafe' })

    const big = meshFixture()
    writeShim(big.shim, `${shimText(big.node, big.script)}#${'x'.repeat(4096)}\n`)
    expect(readShim({ dir: big.dir, uid: UID })).toEqual({ ok: false, reason: 'unsafe' })
  })

  it('refuses any other shape, and a path with a quote, a backslash, a $( or a control character', () => {
    const f = meshFixture()
    const good = shimText(f.node, f.script)
    const cases: Array<[string, string]> = [
      ['a script of its own', '#!/bin/sh\nexec /usr/bin/env node /tmp/x "$@"\n'],
      ['another first line', good.replace('#!/bin/sh', '#!/bin/bash')],
      ['another kind', good.replace('kind=runtime', 'kind=other')],
      ['an edited marker', good.replace('Do not edit.', 'Edited.')],
      ['the lines swapped', good.replace(`node='${f.node}'\nmeshctl='${f.script}'`, `meshctl='${f.script}'\nnode='${f.node}'`)],
      ['double quotes', good.replace(`node='${f.node}'`, `node="${f.node}"`)],
      ['a relative node', good.replace(`node='${f.node}'`, "node='bin/node'")],
      ['a quote in a path', good.replace(`node='${f.node}'`, `node='${f.node}'\\''x'`)],
      ['a $( in a path', good.replace(`meshctl='${f.script}'`, `meshctl='/tmp/$(touch ${join(f.root, 'pwned')})/meshctl.js'`)],
      ['a backtick in a path', good.replace(`meshctl='${f.script}'`, "meshctl='/tmp/`id`/meshctl.js'")],
      ['a backslash in a path', good.replace(`meshctl='${f.script}'`, "meshctl='/tmp/a\\b/meshctl.js'")],
      ['a tab in a path', good.replace(`meshctl='${f.script}'`, "meshctl='/tmp/a\tb/meshctl.js'")],
      ['carriage returns', good.replace(/\n/g, '\r\n')],
      ['a command after the path', good.replace(`node='${f.node}'`, `node='${f.node}'; touch /tmp/x`)],
    ]
    for (const [label, text] of cases) {
      writeShim(f.shim, text)
      expect(readShim({ dir: f.dir, uid: UID }), label).toEqual({ ok: false, reason: 'unrecognized' })
    }
    expect(existsSync(join(f.root, 'pwned'))).toBe(false)
  })

  it('answers stale when the node or the script it names is missing or not a file', () => {
    const f = meshFixture()
    for (const [node, script] of [[join(f.root, 'gone'), f.script], [f.node, join(f.root, 'gone.js')], [f.root, f.script]]) {
      writeShim(f.shim, shimText(node!, script!))
      expect(readShim({ dir: f.dir, uid: UID })).toEqual({ ok: false, reason: 'stale' })
    }
  })
})

describe('meshDirOf and meshEnv: the mesh dir by meshctl’s own rule, and a minimal environment', () => {
  it('takes an absolute AGENT_INBOX_MESH_DIR, else the folder of an absolute AGENT_INBOX_DB, else ~/.agent-inbox', () => {
    expect(meshDirOf({ AGENT_INBOX_MESH_DIR: '/m', AGENT_INBOX_DB: '/d/inbox.db' }, '/h')).toEqual({ dir: '/m' })
    expect(meshDirOf({ AGENT_INBOX_MESH_DIR: 'relative', AGENT_INBOX_DB: '/d/inbox.db' }, '/h')).toEqual({ dir: '/d' })
    expect(meshDirOf({}, '/h')).toEqual({ dir: '/h/.agent-inbox' })
    // a relative database path would resolve against different folders in main and in the child
    expect(meshDirOf({ AGENT_INBOX_DB: 'inbox.db' }, '/h')).toEqual({ reason: 'environment' })
  })

  it('passes only system folders, who and where, and an absolute mesh dir or database', () => {
    expect(meshEnv({
      PATH: '/evil/bin', HOME: '/h', USER: 'u', LOGNAME: 'u', TMPDIR: '/t', LANG: 'C', NODE_OPTIONS: '--require /evil.js', SECRET_TOKEN: 's',
      AGENT_INBOX_MESH_DIR: '/m', AGENT_INBOX_DB: '/d/inbox.db', AGENT_INBOX_PORT: '1',
    })).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TAILSCALE_BE_CLI: '1', HOME: '/h', USER: 'u', LOGNAME: 'u', TMPDIR: '/t', LANG: 'C', AGENT_INBOX_MESH_DIR: '/m', AGENT_INBOX_DB: '/d/inbox.db' })
    expect(meshEnv({ AGENT_INBOX_MESH_DIR: 'm', AGENT_INBOX_DB: 'd' })).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TAILSCALE_BE_CLI: '1' })
  })
})

describe('meshArgv: each fixed operation maps to exactly one argv', () => {
  const files: Record<string, string> = { [`${KEY_HANDLE}:key`]: '/Users/me/.keys/box', [`${TOKEN_HANDLE}:token`]: '/Users/me/token' }
  const pathOf = (handle: string, purpose: string) => files[`${handle}:${purpose}`] ?? null
  const argv = (operation: unknown, values: unknown) => meshArgv(operation, values, pathOf)

  it.each([
    ['servers', {}, ['server', 'list', '--json'], 'servers'],
    ['check-server', { name: 'box' }, ['server', 'check', 'box', '--json'], 'check'],
    ['add-server', { name: 'box', baseUrl: 'https://models.example/llm', key: 'none', apply: false },
      ['server', 'add', 'box', '--base-url', 'https://models.example/llm', '--no-key', '--json'], 'plan'],
    ['add-server', { name: 'box', baseUrl: 'http://127.0.0.1:8080', key: KEY_HANDLE, apply: true },
      ['server', 'add', 'box', '--base-url', 'http://127.0.0.1:8080', '--key-file', '/Users/me/.keys/box', '--json', '--apply'], 'plan'],
    ['add-claude-server', { name: 'claude', apply: false }, ['server', 'add', 'claude', '--claude-code', '--json'], 'plan'],
    ['add-claude-server', { name: 'claude-2', apply: true }, ['server', 'add', 'claude-2', '--claude-code', '--json', '--apply'], 'plan'],
    ['adopt-server', { name: 'box', from: 'unslop', apply: false }, ['server', 'add', 'box', '--from', 'unslop', '--move', '--json'], 'plan'],
    ['adopt-server', { name: 'box', from: 'unslop-code', apply: true }, ['server', 'add', 'box', '--from', 'unslop-code', '--move', '--json', '--apply'], 'plan'],
    ['set-server', { name: 'box', baseUrl: 'https://models.example/v2', apply: false }, ['server', 'set', 'box', '--base-url', 'https://models.example/v2', '--json'], 'plan'],
    ['set-server', { name: 'box', key: 'none', apply: true }, ['server', 'set', 'box', '--no-key', '--json', '--apply'], 'plan'],
    ['set-server', { name: 'box', baseUrl: 'https://m.example', key: KEY_HANDLE, apply: false },
      ['server', 'set', 'box', '--base-url', 'https://m.example', '--key-file', '/Users/me/.keys/box', '--json'], 'plan'],
    ['remove-server', { name: 'box', apply: true }, ['server', 'remove', 'box', '--json', '--apply'], 'plan'],
    ['enable-model-agent', { agent: 'unslop-code', server: 'box', model: 'coder-next', apply: false },
      ['enable', '--unslop-code', '--server', 'box', '--model', 'coder-next', '--json'], 'plan'],
    ['enable-model-agent', { agent: 'unslop', server: 'box', model: 'org/model:7b-q4.1', apply: true },
      ['enable', '--unslop', '--server', 'box', '--model', 'org/model:7b-q4.1', '--json', '--apply'], 'plan'],
    ['enable-request-post', { endpoint: 'https://studio.tail1234.ts.net/a2a', token: TOKEN_HANDLE, apply: false },
      ['enable', '--request-post', '--endpoint', 'https://studio.tail1234.ts.net/a2a', '--token-file', '/Users/me/token', '--json'], 'plan'],
    ['disable', { agent: 'request-post', apply: true }, ['disable', '--request-post', '--json', '--apply'], 'plan'],
    ['disable', { agent: 'unslop', apply: false }, ['disable', '--unslop', '--json'], 'plan'],
    // adding an agent by its card address: Check is a dry run with no --id; Add names the checked id and pin
    ['check-agent', { address: 'https://studio.tailnet-example.ts.net/pdf/.well-known/agent-card.json' },
      ['add', 'https://studio.tailnet-example.ts.net/pdf/.well-known/agent-card.json', '--json'], 'add'],
    ['check-agent', { address: 'http://127.0.0.1:8080/.well-known/agent-card.json', token: TOKEN_HANDLE },
      ['add', 'http://127.0.0.1:8080/.well-known/agent-card.json', '--token-file', '/Users/me/token', '--json'], 'add'],
    ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'pdf-reader', pin: PIN, apply: true },
      ['add', 'https://hub.example.ts.net/a2a', '--id', 'pdf-reader', '--expect-pin', PIN, '--json', '--apply'], 'add'],
    ['add-agent', { address: 'http://127.0.0.1:9000', id: 'echo', pin: PIN, token: TOKEN_HANDLE, apply: false },
      ['add', 'http://127.0.0.1:9000', '--id', 'echo', '--token-file', '/Users/me/token', '--expect-pin', PIN, '--json'], 'add'],
    ['remove-agent', { id: 'pdf-reader', apply: false }, ['remove', 'pdf-reader', '--json'], 'plan'],
    ['remove-agent', { id: 'pdf-reader', apply: true }, ['remove', 'pdf-reader', '--json', '--apply'], 'plan'],
  ] as const)('%s %j', (operation, values, expected, kind) => {
    expect(argv(operation, values)).toEqual({ argv: expected, kind })
  })

  it.each([
    // the operation itself
    ['status', {}], ['server', {}], [{ op: 'servers' }, {}], ['servers', null], ['servers', []], ['servers', 'x'], ['toString', {}], ['__proto__', {}],
    // keys: missing, extra, or meant for another operation
    ['servers', { apply: false }], ['check-server', {}], ['check-server', { name: 'box', apply: true }],
    ['add-server', { name: 'box', baseUrl: 'https://m.example', apply: false }],
    ['add-server', { name: 'box', baseUrl: 'https://m.example', key: 'none' }],
    ['add-server', { name: 'box', baseUrl: 'https://m.example', key: 'none', apply: false, args: ['--purge'] }],
    ['set-server', { name: 'box', apply: false }],
    ['disable', { agent: 'unslop', apply: false, purge: true }],
    // a Claude Code server takes a name only: no address, no key, no program or path
    ['add-claude-server', { name: 'claude' }], ['add-claude-server', { apply: false }],
    ['add-claude-server', { name: 'claude', baseUrl: 'https://m.example', apply: false }],
    ['add-claude-server', { name: 'claude', key: 'none', apply: false }],
    ['add-claude-server', { name: 'claude', kind: 'claude-code', apply: false }],
    ['add-claude-server', { name: 'claude', program: '/usr/local/bin/claude', apply: false }],
    ['add-claude-server', { name: 'Claude', apply: false }], ['add-claude-server', { name: '--claude-code', apply: false }],
    ['add-claude-server', { name: 'claude', apply: 'true' }],
    // apply is a boolean
    ['remove-server', { name: 'box', apply: 'true' }], ['remove-server', { name: 'box', apply: 1 }],
    // a server name
    ['check-server', { name: 'Box' }], ['check-server', { name: '-box' }], ['check-server', { name: '--apply' }], ['check-server', { name: '' }],
    ['check-server', { name: 'a'.repeat(41) }], ['check-server', { name: 'box;rm' }], ['check-server', { name: 'box name' }], ['check-server', { name: 7 }],
    ['check-server', { name: ['box'] }],
    // a model
    ['enable-model-agent', { agent: 'unslop', server: 'box', model: '-m', apply: false }],
    ['enable-model-agent', { agent: 'unslop', server: 'box', model: 'a b', apply: false }],
    ['enable-model-agent', { agent: 'unslop', server: 'box', model: 'm'.repeat(65), apply: false }],
    ['enable-model-agent', { agent: 'unslop', server: 'box', model: '', apply: false }],
    // an agent
    ['enable-model-agent', { agent: 'request-post', server: 'box', model: 'm', apply: false }],
    ['enable-model-agent', { agent: 'web-search', server: 'box', model: 'm', apply: false }],
    ['disable', { agent: 'agents-view', apply: false }], ['disable', { agent: '--purge', apply: false }],
    ['adopt-server', { name: 'box', from: 'request-post', apply: false }],
    // a URL
    ...[
      'ftp://m.example', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@m.example', 'https://user@m.example', 'not a url',
      '-https://m.example', 'https://m.example/\nx', 'https://m.example/\u0000', 'https://m.example/\u0085', ' https://m.example', 'https://m.example/ x',
      `https://m.example/${'a'.repeat(2049)}`, '', 'm.example',
    ].map((baseUrl) => ['add-server', { name: 'box', baseUrl, key: 'none', apply: false }]),
    ['enable-request-post', { endpoint: 'ssh://h', token: TOKEN_HANDLE, apply: false }],
    // a key or token handle
    ['add-server', { name: 'box', baseUrl: 'https://m.example', key: '/Users/me/.keys/box', apply: false }],
    ['add-server', { name: 'box', baseUrl: 'https://m.example', key: 'A'.repeat(32), apply: false }],
    ['add-server', { name: 'box', baseUrl: 'https://m.example', key: 'env:BOX', apply: false }],
    ['enable-request-post', { endpoint: 'https://h.example', token: 'none', apply: false }],
    // adding an agent: Check never writes, Add needs the checked id and pin, Remove an id and apply
    ['check-agent', {}], ['check-agent', { address: 'https://hub.example.ts.net/a2a', apply: false }],
    ['check-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub' }],
    ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', apply: true }],
    ['add-agent', { address: 'https://hub.example.ts.net/a2a', pin: PIN, apply: true }],
    ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin: PIN }],
    ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin: PIN, apply: true, move: 'hub' }],
    ['remove-agent', { id: 'hub' }], ['remove-agent', { id: 'hub', apply: true, purge: true }],
    // a pin is 64 lower-case hex characters
    ...[PIN.toUpperCase(), PIN.slice(1), `${PIN}0`, `-${PIN.slice(1)}`, '', 7].map((pin) => ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin, apply: false }]),
    // a token file goes only with an agent on this Mac
    ['check-agent', { address: 'https://hub.example.ts.net/a2a', token: TOKEN_HANDLE }],
    ['add-agent', { address: 'https://example.org/a2a', id: 'hub', pin: PIN, token: TOKEN_HANDLE, apply: false }],
    ['check-agent', { address: 'http://127.0.0.1:8080', token: 'none' }],
    ['check-agent', { address: 'http://127.0.0.1:8080', token: '/Users/me/token' }],
  ] as Array<[unknown, unknown]>)('refuses %j %j', (operation, values) => {
    expect(argv(operation, values)).toEqual({ reason: 'invalid' })
  })

  // the address rule is add's own (src/mesh-entry.ts addedPlace), copied: the bridge loads nothing but Node's modules
  const host253 = `${Array.from({ length: 4 }, () => 'a'.repeat(61)).join('.')}.abcde`
  it.each([
    'http://127.0.0.1:8080', 'http://127.0.0.1:8080/', 'http://127.0.0.1:1/.well-known/agent-card.json', 'http://127.0.0.1:65535/a', 'http://127.0.0.1:443/a',
    'https://studio.tailnet-example.ts.net/pdf/.well-known/agent-card.json', 'https://hub.example.ts.net:8443/a2a', 'https://example.org', 'https://example.org:80/a',
    'https://a.example.org:1/x', 'https://x1.example/a/b_c~d.e-f', 'https://studio.tailnet-example.ts.net/a/', `https://${'a'.repeat(63)}.example`, `https://${host253}/a`,
    'https://1.2.3.example', 'https://a--b.example/.well-known/agent-card.json', 'https://example.org/a.b/..c/.d',
    'http://127.0.0.1', 'http://127.0.0.1:', 'http://127.0.0.1:80/a', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:08080', 'http://127.0.0.1:99999',
    'http://localhost:8080', 'http://127.0.0.2:8080', 'https://127.0.0.1:8443', 'http://example.org', 'https://example.org:443', 'https://example.org:0', 'https://example.org:65536',
    'https://Example.org', 'https://example', 'https://example.123', 'https://-a.example', 'https://a-.example', `https://${'a'.repeat(64)}.example`, `https://${host253}f/a`,
    'https://example.org/a?b=c', 'https://example.org/a#x', 'https://example.org/./a', 'https://example.org/../a', 'https://example.org/a/..', 'https://example.org/a/.',
    'https://example.org//a', 'https://example.org/a%20b', 'https://user@example.org', 'https://user:pass@example.org', 'ftp://example.org', ' https://example.org',
    'https://example.org/ a', 'https://example.org/\n', '', 'https://example.org.', 'https://ex_ample.org', 'HTTPS://example.org', '-https://example.org', 'https://example.org/é',
    // punycode: a valid label is a name like any other; a malformed one is one the URL parser rejects
    'https://xn--bcher-kva.example/a', 'https://xn--a.example/x', 'https://studio.xn--zz.ts.net/card', 'https://xn--.example',
  ])('an address is accepted exactly where add’s own rule accepts it: %s', (address) => {
    expect(address.length).toBeLessThan(2048)
    // addedPlace refuses, never throws: a host or port its URL parse rejects is outside the rule too
    const accepted = !('refused' in addedPlace(address))
    expect(argv('check-agent', { address }), address).toEqual(accepted ? { argv: ['add', address, '--json'], kind: 'add' } : { reason: 'invalid' })
  })

  it('caps an address at 2048 characters of its own, which add’s rule does not', () => {
    const at = (length: number) => `http://127.0.0.1:8080/${'a'.repeat(length - 'http://127.0.0.1:8080/'.length)}`
    expect('refused' in addedPlace(at(2049))).toBe(false)
    expect(argv('check-agent', { address: at(2048) })).toEqual({ argv: ['add', at(2048), '--json'], kind: 'add' })
    expect(argv('check-agent', { address: at(2049) })).toEqual({ reason: 'invalid' })
  })

  // the id rule is add's own (idRefusal): never a built-in agent's name
  it.each([
    'a', '0', 'pdf-reader', 'echo2', 'a-b', 'a'.repeat(40), 'a--b',
    '', 'A', 'Pdf', '-a', 'a-', 'a'.repeat(41), 'a_b', 'a b', 'é', 'a.b', 'unslop', 'unslop-code', 'request-post', 'web-search',
  ])('an id is accepted exactly where add’s own rule accepts it: %j', (id) => {
    const accepted = idRefusal(id) === undefined
    expect(argv('remove-agent', { id, apply: false })).toEqual(accepted ? { argv: ['remove', id, '--json'], kind: 'plan' } : { reason: 'invalid' })
    expect(argv('add-agent', { address: 'https://example.org/a2a', id, pin: PIN, apply: false })).toEqual(accepted
      ? { argv: ['add', 'https://example.org/a2a', '--id', id, '--expect-pin', PIN, '--json'], kind: 'add' } : { reason: 'invalid' })
  })

  it('refuses a handle it does not know, or one chosen for the other purpose', () => {
    expect(argv('add-server', { name: 'box', baseUrl: 'https://m.example', key: 'c'.repeat(32), apply: false })).toEqual({ reason: 'handle' })
    expect(argv('add-server', { name: 'box', baseUrl: 'https://m.example', key: TOKEN_HANDLE, apply: false })).toEqual({ reason: 'handle' })
    expect(argv('enable-request-post', { endpoint: 'https://h.example', token: KEY_HANDLE, apply: false })).toEqual({ reason: 'handle' })
    expect(argv('check-agent', { address: 'http://127.0.0.1:8080', token: KEY_HANDLE })).toEqual({ reason: 'handle' })
  })
})

describe('meshAnswer: meshctl’s JSON rebuilt field by field', () => {
  it('rebuilds a plan, dropping unknown fields and cutting long strings and lists', () => {
    const long = 'x'.repeat(5000)
    const answer = meshAnswer('plan', JSON.stringify({
      applied: false, steps: [long, ...Array.from({ length: 40 }, (_, i) => `step ${i}`)], notes: ['Nothing to do.'], refused: undefined,
      body: '{"apiKey":"secret"}', key: '/Users/me/.keys/box',
    }), 0)
    expect(answer).toEqual({ ok: true, applied: false, steps: ['x'.repeat(4096), ...Array.from({ length: 31 }, (_, i) => `step ${i}`)], notes: ['Nothing to do.'] })
    expect(meshAnswer('plan', JSON.stringify({ applied: false, steps: [], refused: 'the server box is already in servers.json' }), 1))
      .toEqual({ ok: false, applied: false, steps: [], refused: 'the server box is already in servers.json' })
    expect(meshAnswer('plan', JSON.stringify({ applied: true, steps: ['Added.'] }), 0)).toEqual({ ok: true, applied: true, steps: ['Added.'] })
    // a nonzero exit with no refusal is not ok
    expect(meshAnswer('plan', JSON.stringify({ applied: false, steps: [] }), 1)).toEqual({ ok: false, applied: false, steps: [] })
    // never half a surrogate pair at the cut
    const cut = meshAnswer('plan', JSON.stringify({ applied: false, steps: [`${'a'.repeat(4095)}😀`] }), 0) as { steps: string[] }
    expect(cut.steps[0]).toBe('a'.repeat(4095))
  })

  it('rebuilds the server list and a check, with only their own fields', () => {
    expect(meshAnswer('servers', JSON.stringify({
      servers: [{ name: 'box', baseUrl: 'https://m.example', key: 'file', agents: ['unslop-code'], apiKey: { file: '/k' } }], inline: ['unslop'], extra: 1,
    }), 0)).toEqual({ ok: true, servers: [{ name: 'box', kind: 'http', baseUrl: 'https://m.example', key: 'file', agents: ['unslop-code'] }], inline: ['unslop'] })
    expect(meshAnswer('servers', JSON.stringify({ servers: [], inline: [], refused: 'servers.json is not valid JSON' }), 1))
      .toEqual({ ok: false, servers: [], inline: [], refused: 'servers.json is not valid JSON' })
    expect(meshAnswer('servers', JSON.stringify({ servers: [{ name: 'box', baseUrl: 'https://m.example', key: 'the key itself', agents: [] }], inline: [] }), 0))
      .toEqual({ ok: false, reason: 'output' })
    expect(meshAnswer('check', JSON.stringify({
      server: 'box', baseUrl: 'https://m.example', key: 'file', reachable: true, models: ['m'.repeat(100), ...Array.from({ length: 60 }, (_, i) => `m${i}`)], skipped: 3,
    }), 0)).toEqual({ ok: true, reachable: true, models: ['m'.repeat(64), ...Array.from({ length: 49 }, (_, i) => `m${i}`)], skipped: 3 })
    expect(meshAnswer('check', JSON.stringify({ server: 'box', reachable: false, failure: 'unauthorized', models: [], skipped: 0 }), 1))
      .toEqual({ ok: false, reachable: false, failure: 'unauthorized', models: [], skipped: 0 })
    expect(meshAnswer('check', JSON.stringify({ server: 'box', refused: 'the server box is not in servers.json' }), 1))
      .toEqual({ ok: false, reachable: false, models: [], skipped: 0, refused: 'the server box is not in servers.json' })
    expect(meshAnswer('check', JSON.stringify({ reachable: false, failure: '<b>new</b>', models: [], skipped: 0 }), 1)).toEqual({ ok: false, reason: 'output' })
    expect(meshAnswer('check', JSON.stringify({ reachable: true, models: [], skipped: -1 }), 0)).toEqual({ ok: true, reachable: true, models: [], skipped: 0 })
  })

  it('gives every server row its kind: a Claude Code row has no address, and a row from an older command is an address server', () => {
    const rows = [
      { name: 'claude', kind: 'claude-code', baseUrl: '', key: 'none', agents: ['unslop-code'] },
      { name: 'box', kind: 'http', baseUrl: 'https://m.example', key: 'file', agents: [] },
      // a command older than the Claude Code kind prints no kind
      { name: 'old', baseUrl: 'http://127.0.0.1:8080', key: 'none', agents: [] },
    ]
    expect(meshAnswer('servers', JSON.stringify({ servers: rows, inline: [] }), 0)).toEqual({
      ok: true,
      servers: [
        { name: 'claude', kind: 'claude-code', baseUrl: '', key: 'none', agents: ['unslop-code'] },
        { name: 'box', kind: 'http', baseUrl: 'https://m.example', key: 'file', agents: [] },
        { name: 'old', kind: 'http', baseUrl: 'http://127.0.0.1:8080', key: 'none', agents: [] },
      ],
      inline: [],
    })
    // any other kind fails the list as any other shape error does
    for (const kind of ['ollama', '', null, 1, 'Claude-Code']) {
      expect(meshAnswer('servers', JSON.stringify({ servers: [{ ...rows[1], kind }], inline: [] }), 0), String(kind)).toEqual({ ok: false, reason: 'output' })
    }
    // a Claude Code row still needs the address string, empty as the command prints it
    expect(meshAnswer('servers', JSON.stringify({ servers: [{ name: 'claude', kind: 'claude-code', key: 'none', agents: [] }], inline: [] }), 0)).toEqual({ ok: false, reason: 'output' })
  })

  it('passes a check’s kind only when the command names a valid one, and knows the two Claude Code failures', () => {
    expect(meshAnswer('check', JSON.stringify({ server: 'claude', kind: 'claude-code', reachable: true, models: ['haiku', 'opus', 'sonnet'], skipped: 0 }), 0))
      .toEqual({ ok: true, reachable: true, models: ['haiku', 'opus', 'sonnet'], skipped: 0, kind: 'claude-code' })
    expect(meshAnswer('check', JSON.stringify({ server: 'box', kind: 'http', reachable: true, models: ['m'], skipped: 0 }), 0))
      .toEqual({ ok: true, reachable: true, models: ['m'], skipped: 0, kind: 'http' })
    // an older command: no kind, and the page falls back on its own server list
    expect(meshAnswer('check', JSON.stringify({ server: 'box', reachable: true, models: [], skipped: 0 }), 0)).toEqual({ ok: true, reachable: true, models: [], skipped: 0 })
    for (const failure of ['no-program', 'signed-out', 'timeout']) {
      expect(meshAnswer('check', JSON.stringify({ server: 'claude', kind: 'claude-code', reachable: false, failure, models: [], skipped: 0 }), 1), failure)
        .toEqual({ ok: false, reachable: false, failure, models: [], skipped: 0, kind: 'claude-code' })
    }
    for (const kind of ['ollama', '', null, 7]) {
      expect(meshAnswer('check', JSON.stringify({ server: 'box', kind, reachable: true, models: [], skipped: 0 }), 0), String(kind)).toEqual({ ok: false, reason: 'output' })
    }
    expect(meshAnswer('check', JSON.stringify({ server: 'claude', kind: 'claude-code', reachable: false, failure: 'not-installed', models: [], skipped: 0 }), 1)).toEqual({ ok: false, reason: 'output' })
  })

  // `add --json`'s card (docs/mesh-call.md), as the command prints it
  const CARD = {
    id: 'pdf-reader', name: 'pdf-reader', description: 'Reads a PDF and answers questions about it.', version: '1.0.0', publisher: 'Example Labs',
    reach: 'tailnet', endpoint: 'https://studio.tailnet-example.ts.net/pdf/a2a', signed: true, keysNew: true,
    skills: [{ id: 'read', name: 'read', description: 'Reads one PDF.' }, { id: 'ask' }], pin: PIN,
  }
  const STEPS = ['Would keep the card as /Users/me/.agent-inbox/mesh/cards/pdf-reader.json (0600) for the app to show.', 'Would replace /Users/me/.agent-inbox/mesh.json (keeping a backup beside it):']
  const add = (value: unknown, code = 0) => meshAnswer('add', JSON.stringify(value), code)

  it('rebuilds an add’s plan with its card, field by field, dropping anything else', () => {
    expect(add({ applied: false, steps: STEPS, card: { ...CARD, tokenFile: '/Users/me/token', extra: 1 }, body: 'x' })).toEqual({ ok: true, applied: false, steps: STEPS, card: CARD })
    const { keysNew: _new, description: _d, version: _v, publisher: _p, ...bare } = CARD
    expect(add({ applied: false, steps: STEPS, card: { ...bare, signed: false, reach: 'loopback', endpoint: 'http://127.0.0.1:9000/a2a', skills: [] } }))
      .toEqual({ ok: true, applied: false, steps: STEPS, card: { ...bare, signed: false, reach: 'loopback', endpoint: 'http://127.0.0.1:9000/a2a', skills: [] } })
    expect(Object.keys((add({ applied: false, steps: STEPS, card: CARD }) as { card: object }).card)).toEqual(Object.keys(CARD))
    // an applied add, with its approval note
    expect(add({ applied: true, steps: ['Kept the card.'], notes: ['This --apply is your approval for pdf-reader (D14).'], card: CARD }))
      .toEqual({ ok: true, applied: true, steps: ['Kept the card.'], notes: ['This --apply is your approval for pdf-reader (D14).'], card: CARD })
  })

  it('a refusal before the card is pinned has no card; one after it keeps a valid card', () => {
    const before = add({ applied: false, steps: [], refused: 'the address is outside the rule. Nothing changed.' }, 1)
    expect(before).toEqual({ ok: false, applied: false, steps: [], refused: 'the address is outside the rule. Nothing changed.' })
    expect(before).not.toHaveProperty('card')
    const changed = 'the card is not the one that was checked (its pin differs): check it again. Nothing changed.'
    expect(add({ applied: false, steps: [], refused: changed, card: CARD }, 1)).toEqual({ ok: false, applied: false, steps: [], refused: changed, card: CARD })
    // a derived id that is unusable: the card comes without an id
    const { id: _id, ...noId } = CARD
    expect(add({ applied: false, steps: [], refused: 'the card’s name makes no usable id: pass --id <id>. Nothing changed.', card: noId }, 1))
      .toEqual({ ok: false, applied: false, steps: [], refused: 'the card’s name makes no usable id: pass --id <id>. Nothing changed.', card: noId })
    // a failed step keeps its card
    expect(add({ applied: false, steps: [], refused: 'Failed at step 1/3. Steps before it are done.', card: CARD }, 1)).toMatchObject({ ok: false, card: CARD })
  })

  it('cuts card text to its caps, never half a surrogate pair, and keeps the first 16 skills', () => {
    const answer = add({ applied: false, steps: [], card: {
      ...CARD, name: 'n'.repeat(200), version: 'v'.repeat(200), publisher: `${'p'.repeat(161)}😀`, description: 'd'.repeat(700),
      skills: Array.from({ length: 20 }, (_, i) => ({ id: `${i}${'i'.repeat(200)}`, name: 'k'.repeat(200), description: 's'.repeat(500) })),
    } }) as { card: Record<string, unknown> }
    expect([answer.card['name'], answer.card['version'], answer.card['publisher'], answer.card['description']]).toEqual(['n'.repeat(162), 'v'.repeat(162), 'p'.repeat(161), 'd'.repeat(602)])
    const skills = answer.card['skills'] as Array<Record<string, string>>
    expect(skills).toHaveLength(16)
    expect(skills[0]).toEqual({ id: `0${'i'.repeat(161)}`, name: 'k'.repeat(162), description: 's'.repeat(402) })
  })

  it.each([
    ['a control character in the name', { name: 'pdf\u0007reader' }],
    ['a line break in the description', { description: 'Reads\nPDFs' }],
    ['a C1 control in the publisher', { publisher: 'Example\u0085Labs' }],
    ['a control in a skill', { skills: [{ id: 'read', description: 'one\u0000' }] }],
    // format characters (Unicode Cf) are refused as control characters are
    ['a right-to-left override in the name', { name: 'pdf\u202Ereader' }],
    ['a zero-width space in a skill', { skills: [{ id: 'read', name: 're\u200Bad' }] }],
    ['a byte order mark in the publisher', { publisher: '\uFEFFExample Labs' }],
    ['a skill with no id', { skills: [{ name: 'read' }] }],
    ['a skill that is text', { skills: ['read'] }],
    ['skills that are not a list', { skills: 'read' }],
    ['a name that is not text', { name: 7 }],
    ['an unknown reach', { reach: 'lan' }],
    ['no reach', { reach: undefined }],
    ['a loopback reach on a name', { reach: 'loopback' }],
    ['a tailnet reach on this Mac', { endpoint: 'http://127.0.0.1:9000/a2a' }],
    ['an endpoint outside the rule', { endpoint: 'https://studio.tailnet-example.ts.net/a2a?x=1' }],
    ['an endpoint past 2048 characters', { reach: 'loopback', endpoint: `http://127.0.0.1:9000/${'a'.repeat(2030)}` }],
    ['signed that is not a boolean', { signed: 'yes' }],
    ['keysNew that is not a boolean', { keysNew: 1 }],
    ['an upper-case pin', { pin: PIN.toUpperCase() }],
    ['a short pin', { pin: PIN.slice(2) }],
    ['a built-in id', { id: 'unslop' }],
    ['an id outside the rule', { id: 'PDF reader' }],
  ] as Array<[string, Record<string, unknown>]>)('a card with %s fails the whole answer as output, refused or not', (_label, over) => {
    const card = { ...CARD, ...over }
    expect(add({ applied: false, steps: STEPS, card })).toEqual({ ok: false, reason: 'output' })
    expect(add({ applied: false, steps: [], refused: 'the card is not the one that was checked (its pin differs): check it again. Nothing changed.', card }, 1)).toEqual({ ok: false, reason: 'output' })
  })

  it('a plan with no refusal must carry a card with an id', () => {
    const { id: _id, ...noId } = CARD
    expect(add({ applied: false, steps: STEPS })).toEqual({ ok: false, reason: 'output' })
    expect(add({ applied: false, steps: STEPS, card: noId })).toEqual({ ok: false, reason: 'output' })
    expect(add({ applied: false, steps: STEPS, card: null })).toEqual({ ok: false, reason: 'output' })
    expect(add({ applied: false, steps: [], refused: 'x', card: null }, 1)).toEqual({ ok: false, reason: 'output' })
    expect(meshAnswer('add', '', 2)).toEqual({ ok: false, reason: 'outdated' })
    expect(meshAnswer('add', '{"applied":false,"steps":"x","card":{}}', 0)).toEqual({ ok: false, reason: 'output' })
  })

  it('answers output for anything but its one JSON object, and outdated for a usage error', () => {
    for (const stdout of ['', 'Dry run.\n1/1 Would add', '[]', 'null', '"text"', '{"applied":"yes","steps":[]}', '{"applied":false,"steps":[1]}', '{"applied":false}']) {
      expect(meshAnswer('plan', stdout, 0), stdout).toEqual({ ok: false, reason: 'output' })
    }
    expect(meshAnswer('servers', '{"servers":"box","inline":[]}', 0)).toEqual({ ok: false, reason: 'output' })
    expect(meshAnswer('plan', '', 2)).toEqual({ ok: false, reason: 'outdated' })
  })
})

interface FakeChild extends EventEmitter {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
}

describe('runMeshctl: one run, no shell, bounded', () => {
  it('spawns node with the script and the argv, no shell, from the given folder, stdin closed, in its own group', async () => {
    const child = fakeChild()
    const spawnImpl = vi.fn(() => child)
    const running = runMeshctl({ node: '/rt/bin/node', script: '/rt/dist/meshctl.js', argv: ['server', 'list', '--json'], cwd: '/Users/me', env: { PATH: '/usr/bin' }, spawnImpl })
    child.stdout.end('{"servers":[],"inline":[]}\n')
    child.stderr.end('a warning that is never kept\n')
    child.emit('close', 0)
    await expect(running).resolves.toEqual({ code: 0, stdout: '{"servers":[],"inline":[]}\n' })
    expect(spawnImpl).toHaveBeenCalledWith('/rt/bin/node', ['/rt/dist/meshctl.js', 'server', 'list', '--json'], {
      cwd: '/Users/me', env: { PATH: '/usr/bin' }, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('stops a run that takes longer than its limit: SIGTERM to the group, then SIGKILL', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const killImpl = vi.fn()
    const running = runMeshctl({ node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => child, killImpl })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(killImpl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(killImpl).toHaveBeenLastCalledWith(-4242, 'SIGKILL')
    await expect(running).resolves.toEqual({ reason: 'timeout' })
  })

  it('answers timeout as soon as the stopped run closes', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const running = runMeshctl({ node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => child, killImpl: () => { queueMicrotask(() => child.emit('close', null)) } })
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(running).resolves.toEqual({ reason: 'timeout' })
  })

  it('stops a run whose stdout passes 256 KiB, and keeps none of it', async () => {
    const child = fakeChild()
    const killImpl = vi.fn(() => { queueMicrotask(() => child.emit('close', null)) })
    const running = runMeshctl({ node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => child, killImpl })
    child.stdout.write('x'.repeat(200 * 1024))
    child.stdout.write('x'.repeat(57 * 1024))
    await expect(running).resolves.toEqual({ reason: 'output' })
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
  })

  it('answers failed when the program cannot be started, and quitting when a quit stops it', async () => {
    await expect(runMeshctl({ node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => { throw new Error('EACCES') } })).resolves.toEqual({ reason: 'failed' })
    const errored = fakeChild()
    const failing = runMeshctl({ node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => errored })
    errored.emit('error', new Error('ENOENT'))
    await expect(failing).resolves.toEqual({ reason: 'failed' })

    const child = fakeChild()
    let cancel = () => {}
    const running = runMeshctl({
      node: '/n', script: '/s', argv: [], cwd: '/', env: {}, spawnImpl: () => child,
      killImpl: () => { queueMicrotask(() => child.emit('close', null)) }, onCancel: (fn) => { cancel = fn },
    })
    cancel()
    await expect(running).resolves.toEqual({ reason: 'quitting' })
  })
})

describe('createFileHandles: chosen files by handle', () => {
  it('answers a path only for a live handle of the same purpose, forgets the oldest past 16, and every one after 15 minutes', () => {
    let t = 1000
    let n = 0
    const handles = createFileHandles({ now: () => t, randomHex: () => (n++).toString(16).padStart(32, '0') })
    const first = handles.add('/k/0', 'key')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(handles.lookup(first, 'key')).toBe('/k/0')
    expect(handles.lookup(first, 'token')).toBeNull()
    expect(handles.lookup('f'.repeat(32), 'key')).toBeNull()
    const more = Array.from({ length: 16 }, (_, i) => handles.add(`/k/${i + 1}`, 'key'))
    // the 17th forgot the first
    expect(handles.size()).toBe(16)
    expect(handles.lookup(first, 'key')).toBeNull()
    expect(handles.lookup(more[0], 'key')).toBe('/k/1')
    t += 15 * 60 * 1000 - 1
    expect(handles.lookup(more[15], 'key')).toBe('/k/16')
    t += 1
    expect(handles.lookup(more[15], 'key')).toBeNull()
    expect(handles.size()).toBe(0)
    const again = handles.add('/k/x', 'token')
    handles.clear()
    expect(handles.lookup(again, 'token')).toBeNull()
  })

  it('makes 16 random bytes of hex by default', () => {
    const handles = createFileHandles()
    const a = handles.add('/a', 'key')
    const b = handles.add('/b', 'key')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
  })
})

/** A bridge over a scratch mesh dir with a valid shim, and a fake child per run. */
function bridgeFixture(options: Partial<Parameters<typeof createMeshBridge>[0]> & { answer?: string; code?: number } = {}) {
  const f = meshFixture('mesh-bridge-')
  writeShim(f.shim, shimText(f.node, f.script))
  const spawned: unknown[][] = []
  const children: FakeChild[] = []
  const setupGate = createInstallGate()
  const flags = { quitting: false, updating: false }
  const chosen: Array<string | null> = []
  const bridge = createMeshBridge({
    platform: 'darwin',
    env: () => ({ HOME: f.home, AGENT_INBOX_MESH_DIR: f.dir }),
    home: () => f.home,
    spawnImpl: ((...args: unknown[]) => {
      spawned.push(args)
      const child = fakeChild()
      children.push(child)
      if (options.answer !== undefined) {
        queueMicrotask(() => {
          child.stdout.end(options.answer)
          child.emit('close', options.code ?? 0)
        })
      }
      return child
    }) as never,
    killImpl: (() => { for (const child of children) queueMicrotask(() => child.emit('close', null)) }) as never,
    gate: createInstallGate(),
    choose: async () => chosen.shift() ?? null,
    isQuitting: () => flags.quitting,
    isSetupRunning: () => setupGate.running(),
    isUpdateInstalling: () => flags.updating,
    ...options,
  })
  return { ...f, bridge, spawned, children, setupGate, flags, chosen }
}

const PLAN = JSON.stringify({ applied: false, steps: ['Would add the server box.'] })

describe('createMeshBridge: the gates, the handles and a run', () => {
  it('runs the shim’s node and script with the operation’s argv, from home, with the minimal environment', async () => {
    const b = bridgeFixture({ answer: PLAN })
    expect(b.bridge.available()).toEqual({ available: true })
    await expect(b.bridge.run('remove-server', { name: 'box', apply: false })).resolves.toEqual({ ok: true, applied: false, steps: ['Would add the server box.'] })
    expect(b.spawned).toEqual([[b.node, [b.script, 'server', 'remove', 'box', '--json'], expect.objectContaining({
      cwd: b.home, shell: false, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TAILSCALE_BE_CLI: '1', HOME: b.home, AGENT_INBOX_MESH_DIR: b.dir },
    })]])
  })

  it('adds a Claude Code server with its name only: the argv is main’s own', async () => {
    const b = bridgeFixture({ answer: PLAN })
    await expect(b.bridge.run('add-claude-server', { name: 'claude', apply: true })).resolves.toEqual({ ok: true, applied: false, steps: ['Would add the server box.'] })
    expect(b.spawned.map((args) => args[1])).toEqual([[b.script, 'server', 'add', 'claude', '--claude-code', '--json', '--apply']])
  })

  it('checks an agent on this Mac with a chosen token file, and refuses that file for an agent elsewhere before anything runs', async () => {
    const card = { id: 'echo', name: 'Echo', reach: 'loopback', endpoint: 'http://127.0.0.1:9000/a2a', signed: false, skills: [], pin: PIN }
    const b = bridgeFixture({ answer: JSON.stringify({ applied: false, steps: ['Would copy the bearer token.'], card }) })
    b.chosen.push('/Users/me/echo.token')
    const chosen = await b.bridge.chooseFile('token') as { handle: string }
    await expect(b.bridge.run('check-agent', { address: 'https://hub.example.ts.net/a2a', token: chosen.handle })).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(b.spawned).toEqual([])
    await expect(b.bridge.run('check-agent', { address: 'http://127.0.0.1:9000/card', token: chosen.handle }))
      .resolves.toEqual({ ok: true, applied: false, steps: ['Would copy the bearer token.'], card })
    expect(b.spawned.map((args) => args[1])).toEqual([[b.script, 'add', 'http://127.0.0.1:9000/card', '--token-file', '/Users/me/echo.token', '--json']])
  })

  it('refuses every invalid request before anything is read or spawned', async () => {
    const b = bridgeFixture({ answer: PLAN })
    for (const [operation, values] of [['servers', { apply: true }], ['shell', {}], ['check-server', { name: '--help' }], ['add-server', { name: 'box', baseUrl: 'https://x', key: 'none' }]] as const) {
      await expect(b.bridge.run(operation, values)).resolves.toEqual({ ok: false, reason: 'invalid' })
    }
    await expect(b.bridge.run('add-server', { name: 'box', baseUrl: 'https://m.example', key: KEY_HANDLE, apply: false })).resolves.toEqual({ ok: false, reason: 'handle' })
    expect(b.spawned).toEqual([])
  })

  it('answers each shim problem as its word, from available() and run(), and spawns nothing', async () => {
    const b = bridgeFixture({ answer: PLAN })
    writeShim(b.shim, shimText(b.node, b.script), 0o777)
    expect(b.bridge.available()).toEqual({ available: false, reason: 'unsafe' })
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'unsafe' })
    writeShim(b.shim, shimText(join(b.root, 'gone'), b.script))
    expect(b.bridge.available()).toEqual({ available: false, reason: 'stale' })
    const relative = bridgeFixture({ env: () => ({ AGENT_INBOX_DB: 'inbox.db' }) })
    expect(relative.bridge.available()).toEqual({ available: false, reason: 'environment' })
    const windows = bridgeFixture({ platform: 'win32' })
    expect(windows.bridge.available()).toEqual({ available: false, reason: 'unsupported' })
    await expect(windows.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'unsupported' })
    expect([...b.spawned, ...relative.spawned, ...windows.spawned]).toEqual([])
  })

  it('runs one at a time, and none while Setup runs, an update installs or the app quits', async () => {
    const b = bridgeFixture()
    const first = b.bridge.run('servers', {})
    expect(b.spawned).toHaveLength(1)
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'busy' })
    b.children[0]!.stdout.end('{"servers":[],"inline":[]}')
    b.children[0]!.emit('close', 0)
    await expect(first).resolves.toEqual({ ok: true, servers: [], inline: [] })

    let finishSetup = () => {}
    const setup = b.setupGate.run(() => new Promise<void>((resolve) => { finishSetup = resolve })) as { promise: Promise<void> }
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'setup' })
    finishSetup()
    await setup.promise

    b.flags.updating = true
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'updating' })
    expect(b.bridge.available()).toEqual({ available: false, reason: 'updating' })
    b.flags.updating = false

    b.flags.quitting = true
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'quitting' })
    expect(b.bridge.available()).toEqual({ available: false, reason: 'quitting' })
    await expect(b.bridge.chooseFile('key')).resolves.toEqual({ ok: false, reason: 'quitting' })
    expect(b.spawned).toHaveLength(1)
  })

  it('stops the run in flight when a quit begins, and starts none after', async () => {
    const b = bridgeFixture()
    const running = b.bridge.run('remove-server', { name: 'box', apply: true })
    const stopped = b.bridge.beginQuit()
    expect(stopped).not.toBeNull()
    await expect(stopped).resolves.toBeUndefined()
    await expect(running).resolves.toEqual({ ok: false, reason: 'quitting' })
    await expect(b.bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'quitting' })
    expect(b.spawned).toHaveLength(1)
    expect(b.bridge.beginQuit()).toBeNull()
  })

  it('keeps a chosen file’s path in main, names it to the page by handle and base name only, and forgets it with the grant', async () => {
    const b = bridgeFixture({ answer: PLAN })
    const long = `/Users/me/keys/${'k'.repeat(100)}`
    b.chosen.push('/Users/me/.keys/box key', long, null)
    const chosen = await b.bridge.chooseFile('key') as { ok: true; handle: string; name: string }
    expect(chosen).toEqual({ ok: true, handle: expect.stringMatching(/^[0-9a-f]{32}$/), name: 'box key' })
    expect(JSON.stringify(chosen)).not.toContain('/Users')
    expect(await b.bridge.chooseFile('key')).toEqual({ ok: true, handle: expect.any(String), name: 'k'.repeat(80) })
    expect(await b.bridge.chooseFile('key')).toEqual({ ok: false, reason: 'cancelled' })
    expect(await b.bridge.chooseFile('path')).toEqual({ ok: false, reason: 'invalid' })

    await b.bridge.run('add-server', { name: 'box', baseUrl: 'https://m.example', key: chosen.handle, apply: false })
    expect((b.spawned[0]![1] as string[]).slice(6)).toEqual(['--key-file', '/Users/me/.keys/box key', '--json'])
    // a key file is not a token
    await expect(b.bridge.run('enable-request-post', { endpoint: 'https://h.example', token: chosen.handle, apply: false })).resolves.toEqual({ ok: false, reason: 'handle' })

    // a navigation, a reload or a crash revokes the grant: every handle with it
    b.bridge.revoke()
    await expect(b.bridge.run('add-server', { name: 'box', baseUrl: 'https://m.example', key: chosen.handle, apply: false })).resolves.toEqual({ ok: false, reason: 'handle' })
    expect(b.spawned).toHaveLength(1)
  })

  it('discards a file chosen while the grant was revoked or a quit began, and opens one picker at a time', async () => {
    let answer: (file: string | null) => void = () => {}
    const b = bridgeFixture({ choose: () => new Promise<string | null>((resolve) => { answer = resolve }) })
    const open = b.bridge.chooseFile('token')
    await expect(b.bridge.chooseFile('token')).resolves.toEqual({ ok: false, reason: 'busy' })
    b.bridge.revoke()
    answer('/Users/me/token')
    await expect(open).resolves.toEqual({ ok: false, reason: 'unavailable' })

    const later = b.bridge.chooseFile('token')
    b.flags.quitting = true
    answer('/Users/me/token')
    await expect(later).resolves.toEqual({ ok: false, reason: 'unavailable' })

    const c = bridgeFixture({ choose: async () => 'relative/token' })
    await expect(c.bridge.chooseFile('token')).resolves.toEqual({ ok: false, reason: 'invalid' })
    const d = bridgeFixture({ choose: async () => { throw new Error('no window') } })
    await expect(d.bridge.chooseFile('token')).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('answers output for a run that printed no JSON, and outdated for one that did not know the command', async () => {
    await expect(bridgeFixture({ answer: 'Dry run.\n', code: 0 }).bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'output' })
    await expect(bridgeFixture({ answer: '', code: 2 }).bridge.run('servers', {})).resolves.toEqual({ ok: false, reason: 'outdated' })
  })
})

describe('registerMeshIpc: three channels, exact arity, the settled grant, and nothing for anyone else', () => {
  function channels(granted: boolean) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const calls: unknown[][] = []
    let settled = false
    const bridge = {
      available: () => { calls.push(['available']); return { available: true } },
      run: async (...args: unknown[]) => { calls.push(['run', ...args]); return { ok: true } },
      chooseFile: async (...args: unknown[]) => { calls.push(['chooseFile', ...args]); return { ok: true } },
      revoke: () => {},
      beginQuit: () => null,
    }
    registerMeshIpc({
      ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn as never) } },
      bridge: bridge as never,
      settled: async () => { settled = true },
      isGranted: (() => { expect(settled).toBe(true); return granted }) as never,
    })
    return { handlers, calls }
  }

  it('registers exactly the three channels', () => {
    expect([...channels(true).handlers.keys()]).toEqual(['agent-inbox:mesh-available', 'agent-inbox:mesh-run', 'agent-inbox:mesh-choose-file'])
  })

  it('passes a granted sender’s exact arguments to the bridge, after the grant settled', async () => {
    const { handlers, calls } = channels(true)
    expect(await handlers.get('agent-inbox:mesh-available')!({})).toEqual({ available: true })
    expect(await handlers.get('agent-inbox:mesh-run')!({}, 'servers', {})).toEqual({ ok: true })
    expect(await handlers.get('agent-inbox:mesh-choose-file')!({}, 'key')).toEqual({ ok: true })
    expect(calls).toEqual([['available'], ['run', 'servers', {}], ['chooseFile', 'key']])
  })

  it('refuses a wrong number of arguments, and any sender without the grant, without calling the bridge', async () => {
    const granted = channels(true)
    expect(await granted.handlers.get('agent-inbox:mesh-available')!({}, 'x')).toEqual({ available: false, reason: 'invalid' })
    expect(await granted.handlers.get('agent-inbox:mesh-run')!({}, 'servers')).toEqual({ ok: false, reason: 'invalid' })
    expect(await granted.handlers.get('agent-inbox:mesh-run')!({}, 'servers', {}, '--purge')).toEqual({ ok: false, reason: 'invalid' })
    expect(await granted.handlers.get('agent-inbox:mesh-choose-file')!({})).toEqual({ ok: false, reason: 'invalid' })
    expect(granted.calls).toEqual([])
    const stranger = channels(false)
    expect(await stranger.handlers.get('agent-inbox:mesh-available')!({})).toEqual({ available: false, reason: 'unavailable' })
    expect(await stranger.handlers.get('agent-inbox:mesh-run')!({}, 'servers', {})).toEqual({ ok: false, reason: 'unavailable' })
    expect(await stranger.handlers.get('agent-inbox:mesh-choose-file')!({}, 'key')).toEqual({ ok: false, reason: 'unavailable' })
    expect(stranger.calls).toEqual([])
  })
})

describe('a real run through a real shim (no shell)', () => {
  it('passes the argv as given, the minimal environment and home as the folder, and runs no shell text', async () => {
    const f = meshFixture('mesh-real-')
    // a stand-in for meshctl.js: it records what it was given beside itself, and prints a plan
    const record = join(f.root, 'record.json')
    writeFileSync(f.script, `const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }))
process.stdout.write(JSON.stringify({ applied: false, steps: ['Would add the server box.'], extra: 'dropped' }) + '\\n')
`)
    writeShim(f.shim, shimText(process.execPath, f.script))
    const planted = join(f.root, 'planted')
    // a key file whose name holds shell text: it must arrive as one argument and run nothing
    const keyFile = join(f.root, `box; touch ${planted}; $(touch ${planted})`)
    const bridge = createMeshBridge({
      platform: process.platform,
      env: () => ({ HOME: f.home, USER: 'tester', PATH: '/evil/bin', NODE_OPTIONS: `--require ${join(f.root, 'evil.js')}`, SECRET: 's', AGENT_INBOX_MESH_DIR: f.dir }),
      home: () => f.home,
      spawnImpl: spawn as never,
      gate: createInstallGate(),
      choose: async () => keyFile,
      isQuitting: () => false,
      isSetupRunning: () => false,
      isUpdateInstalling: () => false,
    })
    expect(bridge.available()).toEqual({ available: true })
    const chosen = await bridge.chooseFile('key') as { handle: string }
    const answer = await bridge.run('add-server', { name: 'box', baseUrl: 'https://models.example/llm?x=1&y=$(id)', key: chosen.handle, apply: true })
    expect(answer).toEqual({ ok: true, applied: false, steps: ['Would add the server box.'] })
    const got = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string }
    expect(got.argv).toEqual(['server', 'add', 'box', '--base-url', 'https://models.example/llm?x=1&y=$(id)', '--key-file', keyFile, '--json', '--apply'])
    expect(existsSync(planted)).toBe(false)
    // macOS may add its own text-encoding variable to a child; nothing else is there
    const { __CF_USER_TEXT_ENCODING: _encoding, ...env } = got.env
    expect(env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TAILSCALE_BE_CLI: '1', HOME: f.home, USER: 'tester', AGENT_INBOX_MESH_DIR: f.dir })
    expect(got.cwd).toBe(realpathSync(f.home))
  })
})

// The page's side: agentInboxMesh in electron/setup-preload.cjs, run for real against a fake
// `electron`, so its checks are exercised rather than pinned as text.
function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown, file = 'electron/setup-preload.cjs') {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: { invoke, on: () => {}, removeListener: () => {} },
  }
  const factory = vm.runInThisContext(`(function (require, process) {\n${readFileSync(join(REPO, file), 'utf8')}\n})`, { filename: file }) as
    (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: [] })
  return { exposed, invoke, mesh: exposed.agentInboxMesh as Record<'available' | 'run' | 'chooseFile', (...args: unknown[]) => Promise<unknown>> }
}

describe('agentInboxMesh: the page’s bridge', () => {
  it('has exactly available, run and chooseFile, each sending exactly its arguments on its own channel', async () => {
    const { mesh, invoke } = loadPreload(() => null)
    expect(Object.keys(mesh).sort()).toEqual(['available', 'chooseFile', 'run'])
    await mesh.available()
    await mesh.run('add-server', { name: 'box', baseUrl: 'https://m.example', key: KEY_HANDLE, apply: false })
    await mesh.run('servers', {})
    await mesh.run('add-claude-server', { name: 'claude', apply: false })
    await mesh.chooseFile('token')
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:mesh-available'],
      ['agent-inbox:mesh-run', 'add-server', { name: 'box', baseUrl: 'https://m.example', key: KEY_HANDLE, apply: false }],
      ['agent-inbox:mesh-run', 'servers', {}],
      ['agent-inbox:mesh-run', 'add-claude-server', { name: 'claude', apply: false }],
      ['agent-inbox:mesh-choose-file', 'token'],
    ])
  })

  it('sends a fresh copy of the values, never the page’s own object', async () => {
    const { mesh, invoke } = loadPreload(() => null)
    const values = { name: 'box', apply: true }
    await mesh.run('remove-server', values)
    expect(invoke.mock.calls[0]![2]).toEqual(values)
    expect(invoke.mock.calls[0]![2]).not.toBe(values)
  })

  it.each([
    ['available', ['x']],
    ['run', []], ['run', ['servers']], ['run', ['servers', {}, 'x']], ['run', ['servers', null]], ['run', ['servers', []]],
    ['run', ['shell', {}]], ['run', [['servers'], {}]], ['run', ['servers', { apply: true }]], ['run', ['remove-server', { name: 'box', apply: 'yes' }]],
    ['run', ['check-server', { name: 7 }]], ['run', ['check-server', { name: 'x'.repeat(2049) }]], ['run', ['disable', { agent: 'unslop', apply: false, purge: true }]],
    ['run', ['add-server', { name: 'box', baseUrl: 'https://m.example', key: { file: '/Users/me/.keys/box' }, apply: false }]],
    ['run', ['add-claude-server', { name: 'claude', baseUrl: 'https://m.example', apply: false }]], ['run', ['add-claude-server', { name: 'claude', program: 'claude', apply: false }]],
    ['chooseFile', []], ['chooseFile', ['path']], ['chooseFile', ['key', '/Users/me/.keys/box']],
  ] as const)('refuses %s(%j) without asking main', async (method, args) => {
    const { mesh, invoke } = loadPreload(() => ({ ok: true }))
    const answer = await mesh[method](...args)
    expect(answer).toEqual(method === 'available' ? { available: false, reason: 'invalid' } : { ok: false, reason: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rebuilds every answer against its shape, dropping unknown fields and cutting long strings', async () => {
    const answers: Record<string, unknown> = {
      'agent-inbox:mesh-available': { available: true, node: '/rt/bin/node' },
      'agent-inbox:mesh-choose-file': { ok: true, handle: KEY_HANDLE, name: 'n'.repeat(100), path: '/Users/me/.keys/box' },
    }
    const runs: Record<string, unknown> = {
      servers: {
        ok: true, inline: [], extra: 1,
        servers: [
          { name: 'box', kind: 'http', baseUrl: 'https://m.example', key: 'file', agents: ['unslop'], apiKey: { file: '/k' } },
          { name: 'claude', kind: 'claude-code', baseUrl: '', key: 'none', agents: [] },
        ],
      },
      'check-server': { ok: true, reachable: true, models: ['m'.repeat(100)], skipped: 2, baseUrl: 'https://m.example', kind: 'claude-code' },
      'remove-server': { ok: false, applied: false, steps: ['s'.repeat(5000)], refused: 'named by unslop', notes: ['n'], stderr: 'x' },
    }
    const { mesh } = loadPreload((channel, operation) => (channel === 'agent-inbox:mesh-run' ? runs[operation as string] : answers[channel]))
    expect(await mesh.available()).toEqual({ available: true })
    expect(await mesh.chooseFile('key')).toEqual({ ok: true, handle: KEY_HANDLE, name: 'n'.repeat(80) })
    expect(await mesh.run('servers', {})).toEqual({
      ok: true, inline: [],
      servers: [{ name: 'box', kind: 'http', baseUrl: 'https://m.example', key: 'file', agents: ['unslop'] }, { name: 'claude', kind: 'claude-code', baseUrl: '', key: 'none', agents: [] }],
    })
    expect(await mesh.run('check-server', { name: 'box' })).toEqual({ ok: true, reachable: true, models: ['m'.repeat(64)], skipped: 2, kind: 'claude-code' })
    expect(await mesh.run('remove-server', { name: 'box', apply: false })).toEqual({ ok: false, applied: false, steps: ['s'.repeat(4096)], refused: 'named by unslop', notes: ['n'] })
  })

  it('gives a row with no kind the address kind, as main does; keeps a check’s kind and the Claude Code failures; fails any other kind', async () => {
    const run = async (operation: string, value: unknown) => loadPreload(() => value).mesh.run(operation, operation === 'servers' ? {} : { name: 'x' })
    expect(await run('servers', { ok: true, inline: [], servers: [{ name: 'old', baseUrl: 'http://127.0.0.1:8080', key: 'none', agents: [] }] }))
      .toEqual({ ok: true, inline: [], servers: [{ name: 'old', kind: 'http', baseUrl: 'http://127.0.0.1:8080', key: 'none', agents: [] }] })
    expect(await run('servers', { ok: true, inline: [], servers: [{ name: 'x', kind: 'ollama', baseUrl: '', key: 'none', agents: [] }] })).toEqual({ ok: false, reason: 'failed' })
    expect(await run('check-server', { ok: true, reachable: true, models: [], skipped: 0 })).toEqual({ ok: true, reachable: true, models: [], skipped: 0 })
    for (const failure of ['no-program', 'signed-out']) {
      expect(await run('check-server', { ok: false, reachable: false, failure, models: [], skipped: 0, kind: 'claude-code' }), failure)
        .toEqual({ ok: false, reachable: false, failure, models: [], skipped: 0, kind: 'claude-code' })
    }
    expect(await run('check-server', { ok: true, reachable: true, models: [], skipped: 0, kind: 'ollama' })).toEqual({ ok: false, reason: 'failed' })
  })

  it('sends the three agent operations with exactly their values, and refuses any other key', async () => {
    const { mesh, invoke } = loadPreload(() => null)
    await mesh.run('check-agent', { address: 'http://127.0.0.1:9000/card', token: TOKEN_HANDLE })
    await mesh.run('add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin: PIN, apply: true })
    await mesh.run('remove-agent', { id: 'hub', apply: false })
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:mesh-run', 'check-agent', { address: 'http://127.0.0.1:9000/card', token: TOKEN_HANDLE }],
      ['agent-inbox:mesh-run', 'add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin: PIN, apply: true }],
      ['agent-inbox:mesh-run', 'remove-agent', { id: 'hub', apply: false }],
    ])
    for (const [operation, values] of [
      ['check-agent', { address: 'https://hub.example.ts.net/a2a', apply: true }], ['add-agent', { address: 'https://hub.example.ts.net/a2a', id: 'hub', pin: PIN, apply: true, move: 'hub' }],
      ['remove-agent', { id: 'hub', apply: false, purge: true }], ['check-agent', { address: 'x'.repeat(2049) }],
    ] as const) {
      expect(await mesh.run(operation, values), operation).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('rebuilds an add’s answer with its card, as main does: its own fields and caps, and nothing else', async () => {
    const card = {
      id: 'pdf-reader', name: 'n'.repeat(200), description: 'd'.repeat(700), version: '1.0.0', publisher: 'Example Labs', reach: 'tailnet',
      endpoint: 'https://studio.tailnet-example.ts.net/pdf/a2a', signed: true, keysNew: true, pin: PIN, tokenFile: '/Users/me/token',
      skills: [...Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: 'k'.repeat(200), description: 'x'.repeat(500), tags: ['t'] }))],
    }
    const value = { ok: true, applied: false, steps: ['Would keep the card.'], card, extra: 1 }
    const run = async (operation: string, answer: unknown) => loadPreload(() => answer).mesh.run(operation, operation === 'remove-agent' ? { id: 'hub', apply: false } : { address: 'https://hub.example.ts.net/a2a' })
    const rebuilt = await run('check-agent', value) as { card: Record<string, unknown> }
    expect(rebuilt).toEqual({
      ok: true, applied: false, steps: ['Would keep the card.'],
      card: {
        id: 'pdf-reader', name: 'n'.repeat(162), description: 'd'.repeat(602), version: '1.0.0', publisher: 'Example Labs', reach: 'tailnet',
        endpoint: 'https://studio.tailnet-example.ts.net/pdf/a2a', signed: true, keysNew: true,
        skills: Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, name: 'k'.repeat(162), description: 'x'.repeat(402) })), pin: PIN,
      },
    })
    // a refusal with no card keeps no card key; a refusal with one keeps it
    expect(await run('add-agent', { ok: false, applied: false, steps: [], refused: 'check it again. Nothing changed.' })).toEqual({ ok: false, applied: false, steps: [], refused: 'check it again. Nothing changed.' })
    expect(await run('add-agent', { ...value, ok: false, refused: 'check it again. Nothing changed.' })).toMatchObject({ refused: 'check it again. Nothing changed.', card: { id: 'pdf-reader' } })
    // a card that breaks a rule, or a plan with no refusal and no card id, is failed
    for (const bad of [{ reach: 'lan' }, { pin: PIN.toUpperCase() }, { signed: 'yes' }, { skills: 'read' }, { name: 7 }, { id: undefined }, { endpoint: 7 }]) {
      expect(await run('check-agent', { ...value, card: { ...card, ...bad } }), JSON.stringify(bad)).toEqual({ ok: false, reason: 'failed' })
    }
    expect(await run('check-agent', { ok: true, applied: false, steps: [] })).toEqual({ ok: false, reason: 'failed' })
    // removing is a plan: any card is dropped
    expect(await run('remove-agent', { ok: true, applied: false, steps: ['Would remove hub.'], card })).toEqual({ ok: true, applied: false, steps: ['Would remove hub.'] })
  })

  // G9: the preload's card rules are main's, beyond the reach words: each row through both shapers
  it('rejects and cuts a card exactly as main does', async () => {
    const card = {
      id: 'pdf-reader', name: 'pdf-reader', description: 'Reads a PDF.', publisher: 'Example Labs', reach: 'loopback',
      endpoint: 'http://127.0.0.1:9000/a2a', signed: true, keysNew: true, skills: [{ id: 'read', name: 'read' }], pin: PIN,
    }
    const rows: Array<[string, Record<string, unknown>]> = [
      ['a valid card', {}],
      ['an id outside the rule', { id: 'PDF reader' }],
      ['an id with a capital', { id: 'Pdf' }],
      ['an endpoint past the 2048 cap', { endpoint: `http://127.0.0.1:9000/${'a'.repeat(2030)}` }],
      ['keysNew that is not a boolean', { keysNew: 1 }],
      ['a control character in the name', { name: 'pdf\u0007' }],
      ['a format character in the description', { description: 'Reads\u202E a PDF.' }],
      ['a format character in a skill', { skills: [{ id: 're\u200Bad' }] }],
      ['a name cut inside a surrogate pair', { name: `${'p'.repeat(161)}😀` }],
      ['a skill description cut inside a surrogate pair', { skills: [{ id: 'read', description: `${'d'.repeat(401)}😀` }] }],
    ]
    for (const [label, over] of rows) {
      const raw = { applied: false, steps: ['Would keep the card.'], card: { ...card, ...over } }
      const main = meshAnswer('add', JSON.stringify(raw), 0) as Record<string, unknown>
      const preload = await loadPreload(() => ({ ok: true, ...raw })).mesh.run('check-agent', { address: 'http://127.0.0.1:9000/card' }) as Record<string, unknown>
      if (main['ok'] === false) expect([label, main, preload]).toEqual([label, { ok: false, reason: 'output' }, { ok: false, reason: 'failed' }])
      else expect([label, preload]).toEqual([label, main])
    }
  })

  it('answers failed for a rejected call or an unexpected shape, and passes on only its own refusal words', async () => {
    const thrown = loadPreload(() => { throw new Error('gone') })
    expect(await thrown.mesh.available()).toEqual({ available: false, reason: 'failed' })
    expect(await thrown.mesh.run('servers', {})).toEqual({ ok: false, reason: 'failed' })
    expect(await thrown.mesh.chooseFile('key')).toEqual({ ok: false, reason: 'failed' })
    for (const bad of [null, 'ok', [], { ok: true }, { ok: true, servers: 'box', inline: [] }, { ok: true, servers: [{ name: 'box', baseUrl: 'u', key: 'secret', agents: [] }], inline: [] }]) {
      expect(await loadPreload(() => bad).mesh.run('servers', {}), JSON.stringify(bad)).toEqual({ ok: false, reason: 'failed' })
    }
    expect(await loadPreload(() => ({ ok: true, handle: '/Users/me/.keys/box', name: 'box' })).mesh.chooseFile('key')).toEqual({ ok: false, reason: 'failed' })
    expect(await loadPreload(() => ({ available: 'yes' })).mesh.available()).toEqual({ available: false, reason: 'failed' })
    expect(await loadPreload(() => ({ ok: false, reason: 'not-installed' })).mesh.run('servers', {})).toEqual({ ok: false, reason: 'not-installed' })
    expect(await loadPreload(() => ({ ok: false, reason: 'see /Users/me' })).mesh.run('servers', {})).toEqual({ ok: false, reason: 'failed' })
    expect(await loadPreload(() => ({ available: false, reason: 'unsafe' })).mesh.available()).toEqual({ available: false, reason: 'unsafe' })
    expect(await loadPreload(() => ({ ok: false, reason: 'cancelled' })).mesh.chooseFile('key')).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('names the same operations, with the same keys, and the same refusal words as main', () => {
    const preload = readFileSync(join(REPO, 'electron', 'setup-preload.cjs'), 'utf8')
    const literal = (name: string, close: string) => {
      const at = preload.indexOf(`const ${name} = `)
      expect(at, name).toBeGreaterThan(-1)
      return new Function(`return ${preload.slice(at + `const ${name} = `.length, preload.indexOf(close, at) + close.length)}`)() as unknown
    }
    const operations = literal('MESH_OPERATIONS', '\n})') as Record<string, string[]>
    expect(Object.keys(operations).sort()).toEqual(Object.keys(meshProcess.OPERATIONS).sort())
    for (const [name, spec] of Object.entries(meshProcess.OPERATIONS)) {
      expect([...operations[name]!].sort(), name).toEqual([...spec.required, ...(spec.optional ?? [])].sort())
    }
    expect([...(literal('MESH_REASONS', '\n])') as Set<string>)].sort()).toEqual([...meshProcess.REASONS].sort())
  })

  it('knows the same key kinds, server kinds and check failure words as main', () => {
    const preload = readFileSync(join(REPO, 'electron', 'setup-preload.cjs'), 'utf8')
    const literal = (name: string) => {
      const at = preload.indexOf(`const ${name} = `)
      expect(at, name).toBeGreaterThan(-1)
      return new Function(`return ${preload.slice(at + `const ${name} = `.length, preload.indexOf('])', at) + 2)}`)() as Set<string>
    }
    expect([...literal('MESH_KEYS')].sort()).toEqual([...meshProcess.KEY_KINDS].sort())
    expect([...literal('MESH_SERVER_KINDS')].sort()).toEqual([...meshProcess.SERVER_KINDS].sort())
    expect([...literal('MESH_CHECK_FAILURES')].sort()).toEqual([...meshProcess.CHECK_FAILURES].sort())
    expect([...literal('MESH_REACHES')].sort()).toEqual([...meshProcess.REACHES].sort())
    expect([...meshProcess.REACHES].sort()).toEqual(['loopback', 'public', 'tailnet'])
    expect([...meshProcess.SERVER_KINDS].sort()).toEqual(['claude-code', 'http'])
    expect([...meshProcess.CHECK_FAILURES].sort()).toEqual(['key', 'no-program', 'not-a-model-server', 'signed-out', 'timeout', 'unauthorized', 'unreachable'])
  })

  it('is absent from the view showing another Mac’s Inbox, and the page’s files never name the command', () => {
    expect(Object.keys(loadPreload(() => null, 'electron/remote-preload.cjs').exposed)).toEqual(['agentInboxDesk'])
    const publicFiles = spawnSync('/usr/bin/grep', ['-rl', 'meshctl', join(REPO, 'public')], { encoding: 'utf8' })
    expect(publicFiles.stdout).toBe('')
  })
})
