// The connecting Mac's side of "Use another Mac's Inbox" (#617, PR 3a; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3): electron/remote-connect.cjs
// checks the hub's address, finds the hub among this Mac's Tailscale peers, pairs with a one-time
// code, keeps the device secret encrypted, probes the hub, adds the device header only for the
// hub's origin, and keeps a connection state with retries.
//
// No test runs the real `tailscale`, opens a socket, touches the Keychain or sleeps: Tailscale is
// `fakeTailscale`, the network is a recorded fake `fetch` answering real `Response` objects,
// `safeStorage` is a reversible test double, the clock is a number the test moves, and the store
// is a scratch folder. Values are synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.
// The peer list is shaped like a real `tailscale status --json` (Tailscale 1.102.4): hundreds of
// tagged peers with `Tags` and another user's `UserID`, and one user peer with no `Tags` key.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import remoteConnect from '../electron/remote-connect.cjs'
import remoteConnectRules from '../electron/remote-connect-rules.cjs'
import { inTailnet as tsInTailnet } from '../src/mesh-config.js'
import { suffixFrom as tsSuffixFrom } from '../src/meshctl.js'
import { isDeviceLabel as tsIsDeviceLabel, normaliseCode as tsNormaliseCode } from '../src/remote-pair.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { ALLOWED_ARGS, cliExists, fakeTailscale, tailscaleCalls } from './remote-entry-fixtures.js'

const {
  DEVICE_HEADER, createRemoteConnect, certificateFailure, deviceLabelFor, hubLabelFor, inTailnet, isDeviceLabel, normaliseCode,
  parseHubOrigin, parsePeers, suffixFrom,
} = remoteConnect
const { keychainReady } = remoteConnectRules

afterEach(() => removeScratchDirs())

// Only the full peer list is ever read here, and only by an allowed argument list.
afterAll(() => {
  for (const call of tailscaleCalls) expect(ALLOWED_ARGS, call.args.join(' ')).toContainEqual(call.args)
})

const HOST = 'hub.example.ts.net'
const ORIGIN = `https://${HOST}`
const SUFFIX = 'example.ts.net'
const USER_ID = 7004356810051234
const OTHER_USER = 1234567
const TAGGED_USER = 9001
const NODE = 'nHubStable1CNTRL'

// ── a peer list shaped like the real one ──────────────────────────────────────

interface PeerOptions {
  peers?: number
  hub?: Record<string, unknown> | null
  extra?: Record<string, unknown>[]
  self?: Record<string, unknown>
  top?: Record<string, unknown>
}

/** `tailscale status --json`: Self, the User map, the suffix, `peers` tagged peers and the hub as one untagged user peer. */
function peerStatus(options: PeerOptions = {}): Record<string, unknown> {
  const peer: Record<string, unknown> = {}
  const count = options.peers ?? 530
  for (let i = 0; i < count; i += 1) {
    peer[`nodekey:tag${String(i).padStart(4, '0')}`] = {
      ID: `nTag${i}CNTRL`, PublicKey: `nodekey:tag${i}`, HostName: `exit-${i}`, DNSName: `exit-${i}.${SUFFIX}.`,
      Tags: ['tag:exit'], UserID: TAGGED_USER, Online: i % 3 === 0, OS: 'linux', Relay: 'nyc', ExitNodeOption: true,
      TailscaleIPs: [`100.64.${i >> 8}.${i & 255}`, `fd7a:115c:a1e0::${i.toString(16)}`], Created: '2026-01-01T00:00:00Z',
      LastSeen: '2026-11-17T00:00:00Z',
    }
  }
  if (options.hub !== null) {
    peer['nodekey:hub'] = {
      ID: NODE, PublicKey: 'nodekey:hub', HostName: 'hub', DNSName: `${HOST}.`, UserID: USER_ID, Online: true, ...options.hub,
    }
  }
  for (const [i, extra] of (options.extra ?? []).entries()) peer[`nodekey:extra${i}`] = extra
  return {
    Version: '1.102.4-synthetic',
    BackendState: 'Running',
    MagicDNSSuffix: SUFFIX,
    Self: { ID: 'nLaptopCNTRL', HostName: 'laptop', DNSName: `laptop.${SUFFIX}.`, UserID: USER_ID, Online: true, ...options.self },
    Peer: peer,
    User: {
      [String(USER_ID)]: { ID: USER_ID, LoginName: 'owner@example.com', DisplayName: 'Owner' },
      [String(TAGGED_USER)]: { ID: TAGGED_USER, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' },
      [String(OTHER_USER)]: { ID: OTHER_USER, LoginName: 'friend@example.com', DisplayName: 'Friend' },
    },
    CertDomains: [`laptop.${SUFFIX}`],
    ...options.top,
  }
}

const peersText = (options: PeerOptions = {}) => JSON.stringify(peerStatus(options))

// ── parseHubOrigin ─────────────────────────────────────────────────────────────

describe('parseHubOrigin', () => {
  it('accepts the canonical origin and gives it back with no trailing slash', () => {
    expect(parseHubOrigin(ORIGIN)).toEqual({ ok: true, origin: ORIGIN, host: HOST })
    expect(parseHubOrigin(`${ORIGIN}/`)).toEqual({ ok: true, origin: ORIGIN, host: HOST })
  })

  it('accepts a bare host name typed without https://', () => {
    expect(parseHubOrigin(HOST)).toEqual({ ok: true, origin: ORIGIN, host: HOST })
    expect(parseHubOrigin(`${HOST}/`)).toEqual({ ok: true, origin: ORIGIN, host: HOST })
    expect(parseHubOrigin(`  ${HOST}  `)).toEqual({ ok: true, origin: ORIGIN, host: HOST })
  })

  it('lowercases the scheme and the host', () => {
    expect(parseHubOrigin('HTTPS://HUB.Example.TS.NET')).toEqual({ ok: true, origin: ORIGIN, host: HOST })
    expect(parseHubOrigin('Hub.Example.ts.net')).toEqual({ ok: true, origin: ORIGIN, host: HOST })
  })

  it.each([
    ['http:', `http://${HOST}`],
    ['http: bare-looking', `http://${HOST}/`],
    ['another scheme', `ftp://${HOST}`],
    ['a websocket scheme', `wss://${HOST}`],
    ['user info', `https://owner@${HOST}`],
    ['a user and password', `https://owner:pw@${HOST}`],
    ['an empty user', `https://@${HOST}`],
    ['a port', `https://${HOST}:8443`],
    ['the default port written out', `https://${HOST}:443`],
    ['an empty port', `https://${HOST}:`],
    ['a bare host with a port', `${HOST}:443`],
    ['a path', `https://${HOST}/api`],
    ['a dot path', `https://${HOST}/.`],
    ['an encoded dot path', `https://${HOST}/%2e`],
    ['two slashes', `https://${HOST}//`],
    ['a query', `https://${HOST}/?a=1`],
    ['an empty query', `https://${HOST}?`],
    ['a fragment', `https://${HOST}/#top`],
    ['an empty fragment', `https://${HOST}#`],
    ['an IPv4 address', 'https://100.64.0.1'],
    ['a bare IPv4 address', '100.64.0.1'],
    ['an IPv6 address', 'https://[fd7a:115c:a1e0::1]'],
    ['a trailing dot', `https://${HOST}.`],
    ['a bare trailing dot', `${HOST}.`],
    ['a single label', 'https://hub'],
    ['a backslash', `https://${HOST}\\`],
    ['a backslash before the host', 'https:\\\\hub.example.ts.net'],
    ['a tab inside', `https://hub.exa\tmple.ts.net`],
    ['a newline inside', `https://hub.example.ts.net\n/`],
    ['a space inside', 'https://hub example.ts.net'],
    ['a percent-encoded host', 'https://hub%2eexample.ts.net'],
    ['a non-ASCII host', 'https://hüb.example.ts.net'],
    ['an underscore', 'https://hub_one.example.ts.net'],
    ['three slashes', `https:///${HOST}`],
    ['no slashes', `https:${HOST}`],
    ['empty', ''],
    ['only spaces', '   '],
    ['too long', `https://${'a'.repeat(300)}.ts.net`],
  ])('refuses %s', (_label, text) => {
    expect(parseHubOrigin(text)).toEqual({ ok: false, reason: 'bad_address' })
  })

  it.each([undefined, null, 42, {}, [], new URL(ORIGIN)])('refuses a value that is not a string (%s)', (value) => {
    expect(parseHubOrigin(value)).toEqual({ ok: false, reason: 'bad_address' })
  })
})

// ── the shared rules, mirrored and compared with the TypeScript ones ─────────

const CODE_SAMPLES = [
  '7K3QX-9M2PD', '7k3qx 9m2pd', '7K3QX9M2PD', ' 7K3QX-9M2PD ', '7K3QX--9M2PD', 'ILO0123456', 'iloILO0000', '7K3QX-9M2P',
  '7K3QX-9M2PDA', 'U23456789A', '7K3QX_9M2PD', '7K3QX.9M2PD', '', ' ', '-', '0123456789', 'ABCDEFGHJK', 'ıK3QX-9M2PD', 'ſK3QX-9M2PD',
  '７K3QX-9M2PD', '7K3QX\t9M2PD', '7K3QX\n9M2PD', 'A'.repeat(64), `${'A'.repeat(10)}${' '.repeat(54)}`, `${'A'.repeat(10)}${' '.repeat(55)}`,
  'mnpqrstvwx', 'MNPQRSTVWX', 'yz01234567', 'YZ-01234-567', 'lllllooooo', 'K'.repeat(11),
]

describe('normaliseCode matches the hub (src/remote-pair.ts)', () => {
  it.each(CODE_SAMPLES)('agrees on %j', (text) => {
    expect(normaliseCode(text)).toBe(tsNormaliseCode(text))
  })

  it('agrees over many generated codes', () => {
    const letters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -_.ıſ'
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let n = 0; n < 3000; n += 1) {
      const length = next() % 16
      const text = Array.from({ length }, () => letters[next() % letters.length]).join('')
      expect(normaliseCode(text), text).toBe(tsNormaliseCode(text))
    }
  })

  it('reads I and L as 1 and O as 0, ignoring case, spaces and dashes', () => {
    expect(normaliseCode('il0o1-abcde')).toBe('11001ABCDE')
  })

  it('answers null for a value that is not a string', () => {
    expect(normaliseCode(undefined)).toBeNull()
    expect(normaliseCode(1234567890)).toBeNull()
  })
})

const LABEL_SAMPLES = [
  'laptop', 'L', '', 'a'.repeat(40), 'a'.repeat(41), '😀'.repeat(40), '😀'.repeat(41), 'lap\u0000top', 'lap\u007ftop', 'lap\u0085top',
  'lap​top', 'lap‮top', '﻿laptop', 'lap­top', 'lap\ud800top', 'lap\udc00', '👩‍💻', 'Mac Book', ' laptop ', 'ラップトップ',
]

describe('isDeviceLabel matches the hub (src/remote-pair.ts)', () => {
  it.each(LABEL_SAMPLES)('agrees on %j', (label) => {
    expect(isDeviceLabel(label)).toBe(tsIsDeviceLabel(label))
  })

  it.each([undefined, null, 5, {}, []])('agrees on the non-string %j', (value) => {
    expect(isDeviceLabel(value)).toBe(tsIsDeviceLabel(value))
  })
})

const HOST_SAMPLES = [
  HOST, 'hub.other.ts.net', `a.b.${SUFFIX}`, SUFFIX, `.${SUFFIX}`, 'hub', '', `hub.${SUFFIX}.`, `HUB.${SUFFIX}`, 'hub.example.ts.net.evil.example',
  'evil.example', `hubexample.ts.net`, `x${HOST}`, `${SUFFIX}.${SUFFIX}`,
]
const SUFFIX_SAMPLES = [SUFFIX, 'other.ts.net', undefined, '', 'ts.net', `.${SUFFIX}`, 'EXAMPLE.ts.net']

describe('the tailnet rules match meshctl (src/mesh-config.ts inTailnet, src/meshctl.ts suffixFrom)', () => {
  it('inTailnet agrees over every host and suffix pair', () => {
    for (const host of HOST_SAMPLES) {
      for (const suffix of SUFFIX_SAMPLES) expect(inTailnet(host, suffix), `${host} ${suffix}`).toBe(tsInTailnet(host, suffix))
    }
  })

  const statuses: [string, string][] = [
    ['running', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: SUFFIX })],
    ['stopped', JSON.stringify({ BackendState: 'Stopped', MagicDNSSuffix: SUFFIX })],
    ['needs login', JSON.stringify({ BackendState: 'NeedsLogin', MagicDNSSuffix: SUFFIX })],
    ['no suffix', JSON.stringify({ BackendState: 'Running' })],
    ['a number', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 5 })],
    ['upper case', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 'EXAMPLE.ts.net' })],
    ['not ts.net', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 'example.com' })],
    ['a leading dash', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: '-example.ts.net' })],
    ['a long label', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: `${'a'.repeat(64)}.ts.net` })],
    ['the longest label', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: `${'a'.repeat(63)}.ts.net` })],
    ['two labels', JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: `a.${SUFFIX}` })],
    ['an array', '[]'],
    ['null', 'null'],
    ['not JSON', '{'],
    ['empty', ''],
    ['the real shape', peersText({ peers: 3 })],
  ]
  it.each(statuses)('suffixFrom agrees on %s', (_label, text) => {
    expect(suffixFrom(text)).toBe(tsSuffixFrom(text))
  })
})

describe('labels', () => {
  it("this Mac's name on the hub is its short host name", () => {
    expect(deviceLabelFor('laptop.local')).toBe('laptop')
    expect(deviceLabelFor('Owners-MacBook-Pro.example.com')).toBe('Owners-MacBook-Pro')
    expect(deviceLabelFor('laptop')).toBe('laptop')
  })

  it('drops characters the label rule refuses and cuts to 40 characters', () => {
    expect(deviceLabelFor('lap\u0000​top‮.local')).toBe('laptop')
    expect(deviceLabelFor(`${'m'.repeat(60)}.local`)).toBe('m'.repeat(40))
    expect(deviceLabelFor('😀'.repeat(50))).toBe('😀'.repeat(40))
    for (const name of ['lap\ud800top', `${'é'.repeat(45)}`, 'a\u0085b']) expect(tsIsDeviceLabel(deviceLabelFor(name))).toBe(true)
  })

  it('falls back to Mac', () => {
    for (const name of ['', '.local', '​​.local', undefined, null, 42]) expect(deviceLabelFor(name)).toBe('Mac')
  })

  it("the hub's name on this Mac is its machine, else the first label of its address", () => {
    expect(hubLabelFor('studio', HOST)).toBe('studio')
    expect(hubLabelFor(null, HOST)).toBe('hub')
    expect(hubLabelFor('m'.repeat(64), HOST)).toBe('m'.repeat(40))
    expect(hubLabelFor(null, `${'h'.repeat(50)}.${SUFFIX}`)).toBe('h'.repeat(40))
    expect(tsIsDeviceLabel(hubLabelFor('m'.repeat(64), HOST))).toBe(true)
  })

  // #617 PR 3c: the label is the hub's own choice, and the strip and the menu put it beside This Mac
  it("never takes a machine name that reads as This Mac or local: the address's first label instead", () => {
    for (const machine of ['thismac', 'ThisMac', 'this-mac', 'This_Mac', 'THIS--MAC', 'local', 'Local', 'LOCAL', '_local_', 'lo-cal', 'This.Mac', 'this.mac.', 'lo.cal']) {
      expect(hubLabelFor(machine, HOST), machine).toBe('hub')
    }
    for (const machine of ['thismacbook', 'localhost', 'studio', 'my-local-mac', 'my.local']) expect(hubLabelFor(machine, HOST), machine).toBe(machine)
  })
})

// ── findHub ────────────────────────────────────────────────────────────────────

describe('parsePeers: the hub must be one of this person’s own untagged devices', () => {
  it('finds the one user peer among hundreds of tagged ones, and answers its ID as the node', () => {
    const text = peersText()
    expect(text.length).toBeGreaterThan(100_000)
    expect(parsePeers(text, HOST)).toEqual({ ok: true, node: NODE })
  })

  it('reads a peer whose DNSName has no trailing dot or is in upper case', () => {
    expect(parsePeers(peersText({ hub: { DNSName: HOST } }), HOST)).toEqual({ ok: true, node: NODE })
    expect(parsePeers(peersText({ hub: { DNSName: 'HUB.example.ts.net.' } }), HOST)).toEqual({ ok: true, node: NODE })
  })

  it('accepts null or empty Tags on the hub and on this node', () => {
    expect(parsePeers(peersText({ hub: { Tags: null }, self: { Tags: [] } }), HOST)).toEqual({ ok: true, node: NODE })
    expect(parsePeers(peersText({ hub: { Tags: [] }, self: { Tags: null } }), HOST)).toEqual({ ok: true, node: NODE })
  })

  it.each([
    ['a tagged hub', { hub: { Tags: ['tag:server'] } }, 'tagged_device'],
    ['a hub with Tags that are not a list', { hub: { Tags: 'tag:server' } }, 'tagged_device'],
    ['a hub owned by another user', { hub: { UserID: OTHER_USER } }, 'not_your_device'],
    ['a shared-in node (another user, no tags)', { hub: { UserID: OTHER_USER, Tags: undefined } }, 'not_your_device'],
    ['a hub with no UserID', { hub: { UserID: undefined } }, 'not_your_device'],
    ['a hub whose UserID is not a number', { hub: { UserID: 'x' } }, 'not_your_device'],
    ['no peer with the name', { hub: null }, 'not_found'],
    ['a hub with no ID', { hub: { ID: undefined } }, 'not_found'],
    ['a hub with an empty ID', { hub: { ID: '' } }, 'not_found'],
    ['a hub with a numeric ID', { hub: { ID: 42 } }, 'not_found'],
    ['a stopped backend', { top: { BackendState: 'Stopped' } }, 'not_running'],
    ['a backend that needs a login', { top: { BackendState: 'NeedsLogin' } }, 'not_running'],
    ['a tagged self', { self: { Tags: ['tag:laptop'] } }, 'tagged_self'],
    ['a self with no UserID', { self: { UserID: undefined } }, 'tagged_self'],
    ['a self whose user is the tagged placeholder', { self: { UserID: TAGGED_USER } }, 'tagged_self'],
    ['a self whose user is missing from the map', { self: { UserID: 555 } }, 'tagged_self'],
    ['no suffix', { top: { MagicDNSSuffix: undefined } }, 'not_in_tailnet'],
    ['another tailnet', { top: { MagicDNSSuffix: 'other.ts.net' } }, 'not_in_tailnet'],
    ['no peer map', { top: { Peer: undefined } }, 'not_found'],
    ['a peer map that is a list', { top: { Peer: [] } }, 'not_found'],
  ])('refuses %s', (_label, options, reason) => {
    expect(parsePeers(peersText(options as PeerOptions), HOST)).toEqual({ ok: false, reason })
  })

  // PR 3b: a node is never in its own peer list, so the hub's own name is read from Self, under
  // the same rules: this node untagged with a person's user (checked first, above), a string ID.
  it('accepts this node’s own name as the hub, answering Self.ID as the node', () => {
    const own = { DNSName: `${HOST}.`, ID: 'nSelfStableCNTRL' }
    expect(parsePeers(peersText({ hub: null, self: own }), HOST)).toEqual({ ok: true, node: 'nSelfStableCNTRL' })
    expect(parsePeers(peersText({ hub: null, self: { ...own, DNSName: 'HUB.example.ts.net' } }), HOST)).toEqual({ ok: true, node: 'nSelfStableCNTRL' })
    expect(parsePeers(peersText({ hub: null, self: { ...own, Tags: null } }), HOST)).toEqual({ ok: true, node: 'nSelfStableCNTRL' })
  })

  it.each([
    ['a peer with the same name as this node', { self: { DNSName: `${HOST}.`, ID: 'nSelfCNTRL' } }, 'duplicate_name'],
    ['a tagged peer with the same name as this node', { self: { DNSName: `${HOST}.`, ID: 'nSelfCNTRL' }, hub: { Tags: ['tag:x'], UserID: TAGGED_USER } }, 'duplicate_name'],
    ['this node tagged', { hub: null, self: { DNSName: `${HOST}.`, ID: 'nSelfCNTRL', Tags: ['tag:hub'] } }, 'tagged_self'],
    ['this node on the placeholder user', { hub: null, self: { DNSName: `${HOST}.`, ID: 'nSelfCNTRL', UserID: TAGGED_USER } }, 'tagged_self'],
    ['this node with no ID', { hub: null, self: { DNSName: `${HOST}.`, ID: undefined } }, 'not_found'],
    ['this node with a numeric ID', { hub: null, self: { DNSName: `${HOST}.`, ID: 42 } }, 'not_found'],
    ['this node with an ID holding a space', { hub: null, self: { DNSName: `${HOST}.`, ID: 'n Self' } }, 'not_found'],
    ['this node whose DNSName is not text', { hub: null, self: { DNSName: 7, ID: 'nSelfCNTRL' } }, 'not_found'],
    ['this node under another name', { hub: null, self: { DNSName: `laptop.${SUFFIX}.`, ID: 'nSelfCNTRL' } }, 'not_found'],
  ])('for the own name, refuses %s', (_label, options, reason) => {
    expect(parsePeers(peersText(options as PeerOptions), HOST)).toEqual({ ok: false, reason })
  })

  it('still finds a peer by its name when this node has another name', () => {
    expect(parsePeers(peersText({ self: { DNSName: `laptop.${SUFFIX}.`, ID: 'nLaptopCNTRL' } }), HOST)).toEqual({ ok: true, node: NODE })
  })

  it('refuses a host outside the tailnet, or one level too deep', () => {
    expect(parsePeers(peersText(), 'hub.other.ts.net')).toEqual({ ok: false, reason: 'not_in_tailnet' })
    expect(parsePeers(peersText(), `a.${HOST}`)).toEqual({ ok: false, reason: 'not_in_tailnet' })
  })

  it('refuses two peers claiming the name, even when both look like the hub', () => {
    const twin = { ID: 'nTwinCNTRL', PublicKey: 'nodekey:twin', HostName: 'hub', DNSName: `${HOST}.`, UserID: USER_ID }
    expect(parsePeers(peersText({ extra: [twin] }), HOST)).toEqual({ ok: false, reason: 'duplicate_name' })
    expect(parsePeers(peersText({ extra: [{ ...twin, Tags: ['tag:x'], UserID: TAGGED_USER }] }), HOST)).toEqual({ ok: false, reason: 'duplicate_name' })
  })

  it('compares user ids past 2^53 by their digits, not as floats', () => {
    const big = (selfId: string, peerId: string) => peersText({ self: { UserID: '__SELF__' }, hub: { UserID: '__PEER__' }, top: { User: { [selfId]: { LoginName: 'owner@example.com' } } } })
      .replace('"__SELF__"', selfId).replace('"__PEER__"', peerId)
    // both sides past 2^53, equal
    expect(parsePeers(big('9007199254740993', '9007199254740993'), HOST)).toEqual({ ok: true, node: NODE })
    expect(parsePeers(big('123456789012345678901', '123456789012345678901'), HOST)).toEqual({ ok: true, node: NODE })
    // equal as floats, different as digits
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'))
    expect(parsePeers(big('9007199254740993', '9007199254740992'), HOST)).toEqual({ ok: false, reason: 'not_your_device' })
    expect(parsePeers(big('9007199254740992', '9007199254740993'), HOST)).toEqual({ ok: false, reason: 'not_your_device' })
  })

  it('reads a UserID written as text the same as one written as a number, and refuses one that is not an integer', () => {
    const text = (peer: string) => peersText({ hub: { UserID: '__PEER__' } }).replace('"__PEER__"', peer)
    expect(parsePeers(text(`"${USER_ID}"`), HOST)).toEqual({ ok: true, node: NODE })
    expect(parsePeers(text(`${USER_ID}.0`), HOST)).toEqual({ ok: false, reason: 'not_your_device' })
    expect(parsePeers(text(`${USER_ID}e0`), HOST)).toEqual({ ok: false, reason: 'not_your_device' })
  })

  it.each([['not JSON', '{'], ['an empty answer', ''], ['a list', '[]'], ['null', 'null']])('answers failed for %s', (_label, text) => {
    expect(parsePeers(text, HOST)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('findHub runs the full peer list once', () => {
  it('answers the node from `tailscale status --json`', async () => {
    const execFile = fakeTailscale({ peers: { raw: peersText() } })
    const hub = createRemoteConnect({ filePath: join(scratchDir('rc-'), 'remote-connect.json'), execFile, exists: cliExists })
    expect(await hub.findHub(HOST)).toEqual({ ok: true, node: NODE })
    expect(execFile.calls.map((call) => call.args)).toEqual([['status', '--json']])
    expect(execFile.calls[0]!.options.maxBuffer).toBe(16 * 1024 * 1024)
  })

  it('answers no_cli when no command line is at the fixed paths, and runs nothing', async () => {
    const execFile = fakeTailscale({ peers: { raw: peersText() } })
    const hub = createRemoteConnect({ filePath: join(scratchDir('rc-'), 'remote-connect.json'), execFile, exists: () => false })
    expect(await hub.findHub(HOST)).toEqual({ ok: false, reason: 'no_cli' })
    expect(execFile.calls).toHaveLength(0)
  })

  it('answers failed for a command that fails, and for output over the 16 MiB cap', async () => {
    const failing = fakeTailscale({ peers: { error: Object.assign(new Error('Command failed'), { code: 1 }) } })
    const filePath = join(scratchDir('rc-'), 'remote-connect.json')
    expect(await createRemoteConnect({ filePath, execFile: failing, exists: cliExists }).findHub(HOST)).toEqual({ ok: false, reason: 'failed' })
    const huge = fakeTailscale({ peers: { raw: `${peersText()}${' '.repeat(16 * 1024 * 1024)}` } })
    expect(await createRemoteConnect({ filePath, execFile: huge, exists: cliExists }).findHub(HOST)).toEqual({ ok: false, reason: 'failed' })
  })

  it('refuses a host that is not a host name without running anything', async () => {
    const execFile = fakeTailscale({ peers: { raw: peersText() } })
    const hub = createRemoteConnect({ filePath: join(scratchDir('rc-'), 'remote-connect.json'), execFile, exists: cliExists })
    expect(await hub.findHub('100.64.0.1')).toEqual({ ok: false, reason: 'not_in_tailnet' })
    expect(await hub.findHub(undefined)).toEqual({ ok: false, reason: 'not_in_tailnet' })
    expect(execFile.calls).toHaveLength(0)
  })
})

// ── the harness ────────────────────────────────────────────────────────────────

const SECRET = 'q7Rk2mVx9LpZt4WcYb8NsDf3HjGu6EaQo1XiKvTn0yM'
const DEVICE = '3f9c0a1b2d4e5f60'
const CODE = '7K3QX-9M2PD'
const MARKER = { 'x-agent-inbox-remote-boundary': 'tailnet-v1' }

/** A reversible stand-in for Electron's safeStorage: XOR behind a `v10` prefix, so neither the secret nor its base64 forms appear in what it returns. */
function fakeSafeStorage(available = true) {
  const flip = (bytes: Uint8Array) => Buffer.from(bytes.map((b) => b ^ 0x5a))
  const calls = { encrypt: 0, decrypt: 0 }
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString(text: string) {
      calls.encrypt += 1
      return Buffer.concat([Buffer.from('v10'), flip(Buffer.from(text, 'utf8'))])
    },
    decryptString(blob: Buffer) {
      calls.decrypt += 1
      if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return flip(blob.subarray(3)).toString('utf8')
    },
  }
}

interface FetchCall { url: string; init: RequestInit }
type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/** A recorded fetch: `pair` answers POST /api/remote/pair, `version` answers GET /api/version; anything else is a 404. */
function fakeFetch(routes: { pair?: Route; version?: Route } = {}) {
  const calls: FetchCall[] = []
  let active = 0
  let most = 0
  const fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    active += 1
    most = Math.max(most, active)
    try {
      if (url === `${ORIGIN}/api/remote/pair` && routes.pair) return await routes.pair(url, init)
      if (url === `${ORIGIN}/api/version` && routes.version) return await routes.version(url, init)
      return new Response('Not Found', { status: 404 })
    } finally {
      active -= 1
    }
  }
  return Object.assign(fetch, { calls, most: () => most })
}

const json = (body: unknown, status = 200, headers: Record<string, string> = MARKER) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const pairOk: Route = () => json({ ok: true, device: DEVICE, secret: SECRET })
const versionOk = (current = '2.12.0', machine: unknown = 'studio'): Route => () => json({ current, mode: 'release', machine })
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

/** A TypeError the way Node's fetch reports a failure: `fetch failed`, the reason in `cause` (shapes from real runs of Node 24's fetch). */
const fetchFailed = (code: string | undefined, message: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), code ? { code } : {}) })
const SELF_SIGNED = () => fetchFailed('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate')
const ALTNAME = () => fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames")
const REFUSED_SOCKET = () => fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 100.64.0.2:443')
const TIMEOUT = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

interface HarnessOptions {
  peers?: PeerOptions | (() => unknown)
  fetch?: ReturnType<typeof fakeFetch>
  safeStorage?: ReturnType<typeof fakeSafeStorage>
  hostname?: () => string
  platform?: string
  filePath?: string
  fsImpl?: unknown
  onReload?: () => void
  exists?: (path: string) => boolean
  // #617 PR 4b: the native confirmation of an Open desk command, driven by the test
  confirmDeskCommand?: (command: string) => unknown
}

function harness(options: HarnessOptions = {}) {
  const dir = scratchDir('rc-')
  const filePath = options.filePath ?? join(dir, 'remote-connect.json')
  const clock = { t: Date.parse('2026-11-20T09:00:00.000Z') }
  const peers = options.peers ?? {}
  const execFile = fakeTailscale({ peers: typeof peers === 'function' ? (() => peers()) as never : { raw: peersText(peers) } })
  const fetch = options.fetch ?? fakeFetch({ pair: pairOk, version: versionOk() })
  const safeStorage = options.safeStorage ?? fakeSafeStorage()
  const intervals: unknown[] = []
  let reloads = 0
  const connect = createRemoteConnect({
    filePath,
    execFile,
    exists: options.exists ?? cliExists,
    fetch,
    safeStorage,
    platform: options.platform ?? 'darwin',
    hostname: options.hostname ?? (() => 'laptop.local'),
    now: () => clock.t,
    setInterval: (fn: () => void) => { intervals.push(fn); return { unref() {} } },
    clearInterval: () => { intervals.length = 0 },
    onReload: options.onReload ?? (() => { reloads += 1 }),
    ...(options.fsImpl ? { fsImpl: options.fsImpl } : {}),
    ...(options.confirmDeskCommand ? { confirmDeskCommand: options.confirmDeskCommand as never } : {}),
  })
  return { dir, filePath, clock, execFile, fetch, safeStorage, connect, intervals, reloads: () => reloads }
}

const readStore = (filePath: string) => JSON.parse(readFileSync(filePath, 'utf8')) as {
  schema: number; active: string | null; hubs: Record<string, Record<string, unknown>>; [key: string]: unknown
}

/** Every form of the secret that must never be on disk or in a page-visible value. */
const secretForms = () => [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64url'), Buffer.from(SECRET).toString('hex')]

// ── connect ────────────────────────────────────────────────────────────────────

describe('connect', () => {
  it('pairs, stores the secret only encrypted, probes the hub and stores its machine as the label', async () => {
    const h = harness()
    const result = await h.connect.connect({ address: HOST, code: CODE })
    expect(result).toMatchObject({ ok: true, label: 'studio', state: 'online', reason: null })
    const store = readStore(h.filePath)
    expect(store.schema).toBe(1)
    expect(store.active).toMatch(/^[0-9a-f]{8}$/)
    expect(result.ok && result.id).toBe(store.active)
    const entry = store.hubs[store.active!]!
    expect(Object.keys(store.hubs)).toEqual([store.active])
    expect(entry).toMatchObject({ origin: ORIGIN, label: 'studio', node: NODE, machine: 'studio', device: DEVICE })
    expect(typeof entry.secret).toBe('string')
    // only encrypted: no form of the plain secret anywhere in the file, and the blob decrypts back to it
    const text = readFileSync(h.filePath, 'utf8')
    for (const form of secretForms()) expect(text).not.toContain(form)
    expect(fakeSafeStorage().decryptString(Buffer.from(entry.secret as string, 'base64'))).toBe(SECRET)
    expect(h.safeStorage.calls.encrypt).toBe(1)
  })

  it('posts exactly { code, label } with Origin and Content-Type, no device header, redirects refused and a timeout', async () => {
    const h = harness({ hostname: () => 'Owners-MacBook-Pro.local' })
    await h.connect.connect({ address: `${ORIGIN}/`, code: '7k3qx 9m2pd' })
    const pair = h.fetch.calls[0]!
    expect(pair.url).toBe(`${ORIGIN}/api/remote/pair`)
    expect(pair.init.method).toBe('POST')
    expect(pair.init.headers).toEqual({ Origin: ORIGIN, 'Content-Type': 'application/json' })
    expect(headerOf(pair.init, DEVICE_HEADER)).toBeNull()
    expect(headerOf(pair.init, 'cookie')).toBeNull()
    expect(JSON.parse(pair.init.body as string)).toEqual({ code: '7K3QX9M2PD', label: 'Owners-MacBook-Pro' })
    expect(Object.keys(JSON.parse(pair.init.body as string))).toEqual(['code', 'label'])
    expect(pair.init.redirect).toBe('error')
    expect(pair.init.signal).toBeInstanceOf(AbortSignal)
    // the probe that follows carries the device header, to the hub's origin
    const probe = h.fetch.calls[1]!
    expect(probe.url).toBe(`${ORIGIN}/api/version`)
    expect(headerOf(probe.init, DEVICE_HEADER)).toBe(SECRET)
    expect(probe.init.redirect).toBe('error')
    expect(h.fetch.calls).toHaveLength(2)
  })

  it('sends Mac as the label when the host name gives nothing usable or cannot be read', async () => {
    const h = harness({ hostname: () => { throw new Error('no host name') } })
    await h.connect.connect({ address: HOST, code: CODE })
    expect(JSON.parse(h.fetch.calls[0]!.init.body as string).label).toBe('Mac')
  })

  it('refuses without the Keychain before any command or network call', async () => {
    const h = harness({ safeStorage: fakeSafeStorage(false) })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'no_keychain' })
    expect(h.fetch.calls).toHaveLength(0)
    expect(h.execFile.calls).toHaveLength(0)
    expect(existsSync(h.filePath)).toBe(false)
  })

  it('refuses a Keychain check that throws the same way', async () => {
    const safeStorage = { ...fakeSafeStorage(), isEncryptionAvailable: () => { throw new Error('no') } }
    const h = harness({ safeStorage: safeStorage as never })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'no_keychain' })
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('refuses off macOS', async () => {
    const h = harness({ platform: 'linux' })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'unsupported' })
    expect(h.fetch.calls).toHaveLength(0)
  })

  it.each(['7K3QX-9M2P', 'U23456789A', '7K3QX_9M2PD', '', 'ıK3QX-9M2PD', undefined, 1234567890])('refuses the malformed code %j locally: it never reaches the network', async (code) => {
    const h = harness()
    expect(await h.connect.connect({ address: HOST, code })).toEqual({ ok: false, reason: 'bad_code' })
    expect(h.fetch.calls).toHaveLength(0)
    expect(h.execFile.calls).toHaveLength(0)
  })

  it('refuses a bad address before anything runs', async () => {
    const h = harness()
    expect(await h.connect.connect({ address: `http://${HOST}`, code: CODE })).toEqual({ ok: false, reason: 'bad_address' })
    expect(await h.connect.connect({ code: CODE })).toEqual({ ok: false, reason: 'bad_address' })
    expect(await h.connect.connect(undefined)).toEqual({ ok: false, reason: 'bad_address' })
    expect(h.fetch.calls).toHaveLength(0)
    expect(h.execFile.calls).toHaveLength(0)
  })

  it.each([
    ['a tagged hub', { hub: { Tags: ['tag:server'] } }, 'tagged_device'],
    ['another user’s hub', { hub: { UserID: OTHER_USER } }, 'not_your_device'],
    ['no such peer', { hub: null }, 'not_found'],
    ['a stopped backend', { top: { BackendState: 'Stopped' } }, 'not_running'],
    ['a tagged laptop', { self: { Tags: ['tag:laptop'] } }, 'tagged_self'],
    ['another tailnet', { top: { MagicDNSSuffix: 'other.ts.net' } }, 'not_in_tailnet'],
  ])('refuses %s before posting the code', async (_label, peers, reason) => {
    const h = harness({ peers })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason })
    expect(h.fetch.calls).toHaveLength(0)
    expect(existsSync(h.filePath)).toBe(false)
  })

  it('refuses when the command line is missing, before posting the code', async () => {
    const h = harness({ exists: () => false })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'no_cli' })
    expect(h.fetch.calls).toHaveLength(0)
  })

  it.each([
    ['a self-signed certificate', () => { throw SELF_SIGNED() }, 'bad_certificate'],
    ['a certificate for another name', () => { throw ALTNAME() }, 'bad_certificate'],
    ['an expired certificate', () => { throw fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired') }, 'bad_certificate'],
    ['a refused connection', () => { throw REFUSED_SOCKET() }, 'unreachable'],
    ['a name that does not resolve', () => { throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND hub.example.ts.net') }, 'unreachable'],
    ['plain HTTP on 443', () => { throw fetchFailed('ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number') }, 'unreachable'],
    ['a timeout', () => { throw TIMEOUT() }, 'unreachable'],
    ['a redirect, refused by fetch', () => { throw fetchFailed(undefined, 'unexpected redirect') }, 'unreachable'],
    ['something thrown that is not an error', () => { throw 'boom' }, 'unreachable'],
    ['a 403 (a wrong or expired code, or a login the hub does not allow)', () => new Response('Forbidden', { status: 403 }), 'refused'],
    ['a 403 with the marker', () => new Response('Forbidden', { status: 403, headers: MARKER }), 'refused'],
    ['a 200 without the marker', () => json({ ok: true, device: DEVICE, secret: SECRET }, 200, {}), 'not_agent_inbox'],
    ['a 200 with another marker', () => json({ ok: true, device: DEVICE, secret: SECRET }, 200, { 'x-agent-inbox-remote-boundary': 'tailnet-v2' }), 'not_agent_inbox'],
    ['a 200 with the local marker', () => json({ ok: true, device: DEVICE, secret: SECRET }, 200, { 'x-agent-inbox-local-boundary': 'loopback-v1' }), 'not_agent_inbox'],
    ['a 302', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/', ...MARKER } }), 'not_agent_inbox'],
    ['a 404', () => new Response('Not Found', { status: 404, headers: MARKER }), 'not_agent_inbox'],
    ['a 500', () => json({ ok: true, device: DEVICE, secret: SECRET }, 500), 'not_agent_inbox'],
    ['a 401', () => new Response('', { status: 401 }), 'not_agent_inbox'],
    ['a body over 1 KiB', () => json(JSON.stringify({ ok: true, device: DEVICE, secret: SECRET, pad: 'x'.repeat(1024) })), 'not_agent_inbox'],
    ['a body that is not JSON', () => json('{"ok":true,'), 'not_agent_inbox'],
    ['an empty body', () => new Response(null, { status: 200, headers: MARKER }), 'not_agent_inbox'],
    ['a list', () => json([{ ok: true, device: DEVICE, secret: SECRET }]), 'not_agent_inbox'],
    ['ok false', () => json({ ok: false, device: DEVICE, secret: SECRET }), 'not_agent_inbox'],
    ['ok as text', () => json({ ok: 'true', device: DEVICE, secret: SECRET }), 'not_agent_inbox'],
    ['no device', () => json({ ok: true, secret: SECRET }), 'not_agent_inbox'],
    ['an upper-case device id', () => json({ ok: true, device: DEVICE.toUpperCase(), secret: SECRET }), 'not_agent_inbox'],
    ['a short device id', () => json({ ok: true, device: DEVICE.slice(1), secret: SECRET }), 'not_agent_inbox'],
    ['no secret', () => json({ ok: true, device: DEVICE }), 'not_agent_inbox'],
    ['a 42-character secret', () => json({ ok: true, device: DEVICE, secret: SECRET.slice(1) }), 'not_agent_inbox'],
    ['a 44-character secret', () => json({ ok: true, device: DEVICE, secret: `${SECRET}A` }), 'not_agent_inbox'],
    ['a secret in base64, not base64url', () => json({ ok: true, device: DEVICE, secret: `${SECRET.slice(1)}+` }), 'not_agent_inbox'],
    ['a secret as a number', () => json({ ok: true, device: DEVICE, secret: 42 }), 'not_agent_inbox'],
  ])('answers a pairing that meets %s with a fixed word, and stores nothing', async (_label, pair, reason) => {
    const fetch = fakeFetch({ pair: pair as Route, version: versionOk() })
    const h = harness({ fetch })
    const result = await h.connect.connect({ address: HOST, code: CODE })
    expect(result).toEqual({ ok: false, reason })
    expect(fetch.calls).toHaveLength(1)
    expect(existsSync(h.filePath)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('keeps the pairing when the first probe fails, and says so', async () => {
    const fetch = fakeFetch({ pair: pairOk, version: () => { throw REFUSED_SOCKET() } })
    const h = harness({ fetch })
    const result = await h.connect.connect({ address: HOST, code: CODE })
    expect(result).toMatchObject({ ok: true, label: 'hub', state: 'retrying', reason: 'unreachable' })
    const store = readStore(h.filePath)
    expect(store.hubs[store.active!]).toMatchObject({ origin: ORIGIN, label: 'hub', node: NODE, machine: null, device: DEVICE })
  })

  it('keeps the pairing when the first probe is refused, and says so', async () => {
    const fetch = fakeFetch({ pair: pairOk, version: () => new Response('Forbidden', { status: 403 }) })
    const h = harness({ fetch })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toMatchObject({ ok: true, label: 'hub', state: 'refused', reason: 'refused' })
    expect(readStore(h.filePath).active).not.toBeNull()
  })

  it('says the hub holds a device it cannot use when the Keychain fails after pairing, and stores nothing', async () => {
    const safeStorage = { ...fakeSafeStorage(), encryptString: () => { throw new Error('Keychain refused') } }
    const h = harness({ safeStorage: safeStorage as never })
    const result = await h.connect.connect({ address: HOST, code: CODE })
    expect(result).toEqual({ ok: false, reason: 'no_keychain', pairedOnHub: true })
    expect(existsSync(h.filePath)).toBe(false)
  })

  it('says the hub holds a device it cannot use when the write fails after pairing', async () => {
    const fsImpl = { ...(await import('node:fs/promises')).default, rename: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    const h = harness({ fsImpl })
    const result = await h.connect.connect({ address: HOST, code: CODE })
    expect(result).toEqual({ ok: false, reason: 'write_failed', pairedOnHub: true })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('certificateFailure recognises how Node’s fetch reports a TLS error', () => {
  it.each([
    ['self-signed', SELF_SIGNED(), true],
    ['another name', ALTNAME(), true],
    ['expired', fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired'), true],
    ['an unknown issuer', fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'), true],
    ['an unverifiable leaf', fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'), true],
    ['a self-signed chain', fetchFailed('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'), true],
    ['a nested cause', new TypeError('fetch failed', { cause: new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) }) }), true],
    ['a refused connection', REFUSED_SOCKET(), false],
    ['plain HTTP on 443', fetchFailed('ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number'), false],
    ['a timeout', TIMEOUT(), false],
    ['a redirect', fetchFailed(undefined, 'unexpected redirect'), false],
    ['a string', 'CERT_HAS_EXPIRED', false],
    ['null', null, false],
  ])('%s', (_label, error, expected) => {
    expect(certificateFailure(error)).toBe(expected)
  })

  it('stops on a cause chain that loops', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(certificateFailure(a)).toBe(false)
  })
})

// ── the store ──────────────────────────────────────────────────────────────────

const ID_A = 'a1b2c3d4'
const ID_B = 'b1b2c3d4'
const BLOB = Buffer.concat([Buffer.from('v10'), Buffer.from(SECRET).map((b) => b ^ 0x5a)]).toString('base64')
const entry = (over: Record<string, unknown> = {}) => ({ origin: ORIGIN, label: 'studio', node: NODE, machine: 'studio', device: DEVICE, secret: BLOB, ...over })
const writeStore = (filePath: string, value: unknown) => writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })

describe('the store', () => {
  it('refuses a second hub without replace, before any command or network call', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    const before = readFileSync(h.filePath, 'utf8')
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'hub_exists' })
    expect(h.fetch.calls).toHaveLength(0)
    expect(h.execFile.calls).toHaveLength(0)
    expect(readFileSync(h.filePath, 'utf8')).toBe(before)
  })

  it('replaces the hub when the owner confirms, keeping unknown top-level fields', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ label: 'old' }) }, future: { kept: true } })
    const result = await h.connect.connect({ address: HOST, code: CODE, replace: true })
    expect(result.ok).toBe(true)
    const store = readStore(h.filePath)
    expect(store.future).toEqual({ kept: true })
    expect(Object.keys(store.hubs)).toEqual([store.active])
    expect(store.active).not.toBe(ID_A)
  })

  it('never writes over a newer schema, even when told to replace', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 2, active: null, hubs: {} })
    const before = readFileSync(h.filePath, 'utf8')
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'newer_schema' })
    expect(await h.connect.connect({ address: HOST, code: CODE, replace: true })).toEqual({ ok: false, reason: 'newer_schema' })
    expect(h.fetch.calls).toHaveLength(0)
    expect(readFileSync(h.filePath, 'utf8')).toBe(before)
  })

  it('leaves a bad file alone unless the owner confirms', async () => {
    const h = harness()
    writeStore(h.filePath, '{ not json')
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'bad_file' })
    expect(readFileSync(h.filePath, 'utf8')).toBe('{ not json')
    expect(h.fetch.calls).toHaveLength(0)
    expect((await h.connect.connect({ address: HOST, code: CODE, replace: true })).ok).toBe(true)
    expect(readStore(h.filePath).schema).toBe(1)
  })

  it('writes the file 0600', async () => {
    const h = harness()
    await h.connect.connect({ address: HOST, code: CODE })
    expect(statSync(h.filePath).mode & 0o777).toBe(0o600)
  })

  it('records the machine and the final label the first time a later probe is online, keeping unknown entry fields', async () => {
    let online = false
    const fetch = fakeFetch({ pair: pairOk, version: () => (online ? json({ current: '2.12.0', machine: 'studio' }) : new Response('', { status: 502 })) })
    const h = harness({ fetch })
    const first = await h.connect.connect({ address: HOST, code: CODE })
    expect(first).toMatchObject({ ok: true, label: 'hub', state: 'retrying', reason: 'not_agent_inbox' })
    const store = readStore(h.filePath)
    store.hubs[store.active!]!.future = 'kept'
    writeStore(h.filePath, store)
    online = true
    expect(await h.connect.probeHub()).toEqual({ ok: true, state: 'online', version: '2.12.0', machine: 'studio' })
    expect(readStore(h.filePath).hubs[store.active!]).toMatchObject({ label: 'studio', machine: 'studio', future: 'kept' })
    expect(h.connect.connection()).toMatchObject({ mode: 'hub', label: 'studio', state: 'online' })
  })
})

describe('view', () => {
  it('shows no hub and no problem with no file', async () => {
    const h = harness()
    expect(await h.connect.view()).toEqual({ available: true, keychain: true, hub: null, problem: null })
  })

  it('reads Linux’s plain-text secret store as no Keychain', () => {
    const basic = { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' }
    expect(keychainReady(basic, 'linux')).toBe(false)
    expect(keychainReady({ ...basic, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux')).toBe(true)
  })

  it('says when this Mac cannot connect at all', async () => {
    expect((await harness({ platform: 'linux' }).connect.view()).available).toBe(false)
  })

  // The local page reads view() at every start (the strip). Asking macOS for the Keychain there
  // would create the app's Keychain item, and could prompt, for people who never use this.
  it('never asks the Keychain until something needs it, and from then on says what the Keychain says', async () => {
    let asked = 0
    let unlocked = false
    const storage = { ...fakeSafeStorage(), isEncryptionAvailable: () => { asked += 1; return unlocked } }
    const h = harness({ safeStorage: storage as never })
    // the app's start with no Mac stored, then the page's reads
    await h.connect.start()
    expect((await h.connect.view()).keychain).toBe(true)
    expect((await h.connect.view()).keychain).toBe(true)
    expect(asked).toBe(0)
    // a connect needs it
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'no_keychain' })
    expect(asked).toBe(1)
    expect((await h.connect.view()).keychain).toBe(false)
    // and view() asks again each time from then on, so unlocking is seen when Settings is opened again
    unlocked = true
    expect((await h.connect.view()).keychain).toBe(true)
    expect(asked).toBe(3)
  })

  it('asks the Keychain for a stored hub at start, as it must to read the key, and view() then reports it', async () => {
    const first = harness()
    expect(await first.connect.connect({ address: HOST, code: CODE })).toMatchObject({ ok: true })
    let asked = 0
    const storage = { ...fakeSafeStorage(), isEncryptionAvailable: () => { asked += 1; return true } }
    const again = harness({ filePath: first.filePath, safeStorage: storage as never })
    await again.connect.probeHub()
    expect(asked).toBeGreaterThan(0)
    expect((await again.connect.view()).keychain).toBe(true)
  })

  it('shows the hub with its state, and never the secret, the blob, the device id or the node id', async () => {
    const h = harness()
    const { id } = idOf(await h.connect.connect({ address: HOST, code: CODE }))
    const view = await h.connect.view()
    expect(view).toEqual({ available: true, keychain: true, hub: { id, label: 'studio', origin: ORIGIN, machine: 'studio', state: 'online', reason: null, deskCommand: null }, problem: null })
    const text = JSON.stringify(view)
    for (const value of [...secretForms(), readStore(h.filePath).hubs[id]!.secret as string, DEVICE, NODE]) expect(text).not.toContain(value)
  })

  it.each([
    ['not JSON', '{', 'not_json'],
    ['not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), 'not_json'],
    ['a list', '[]', 'not_json'],
    ['no schema', { active: null, hubs: {} }, 'bad_schema'],
    ['schema 0', { schema: 0, active: null, hubs: {} }, 'bad_schema'],
    ['a newer schema', { schema: 2, active: ID_A, hubs: { [ID_A]: entry() } }, 'newer_schema'],
    ['an http origin', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ origin: `http://${HOST}` }) } }, 'bad_entry'],
    ['an origin with a slash', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ origin: `${ORIGIN}/` }) } }, 'bad_entry'],
    ['an upper-case origin', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ origin: 'https://HUB.example.ts.net' }) } }, 'bad_entry'],
    ['a long label', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ label: 'x'.repeat(41) }) } }, 'bad_entry'],
    ['a label with a bidirectional control', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ label: 'hub‮' }) } }, 'bad_entry'],
    ['an empty node', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ node: '' }) } }, 'bad_entry'],
    ['a node with a space', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ node: 'n 1' }) } }, 'bad_entry'],
    ['a bad machine', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ machine: '-studio' }) } }, 'bad_entry'],
    ['a bad device id', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ device: 'xyz' }) } }, 'bad_entry'],
    ['a plain secret instead of a blob', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ secret: SECRET }) } }, 'bad_entry'],
    ['no secret', { schema: 1, active: ID_A, hubs: { [ID_A]: entry({ secret: undefined }) } }, 'bad_entry'],
    ['a bad hub id', { schema: 1, active: 'A1B2C3D4', hubs: { A1B2C3D4: entry() } }, 'bad_entry'],
    ['an active id with no entry', { schema: 1, active: ID_B, hubs: { [ID_A]: entry() } }, 'bad_entry'],
    ['hubs as a list', { schema: 1, active: null, hubs: [] }, 'bad_entry'],
    ['a second, bad entry', { schema: 1, active: ID_A, hubs: { [ID_A]: entry(), [ID_B]: entry({ device: 'bad' }) } }, 'bad_entry'],
  ])('reads %s as no hub with a fixed problem word', async (_label, content, problem) => {
    const h = harness()
    writeStore(h.filePath, content instanceof Buffer ? content.toString('latin1') : content)
    if (content instanceof Buffer) writeFileSync(h.filePath, content)
    expect(await h.connect.view()).toEqual({ available: true, keychain: true, hub: null, problem })
  })

  it('reads a file over 64 KiB as too_large, and one it cannot read as unreadable', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: null, hubs: {}, pad: 'x'.repeat(64 * 1024) })
    expect((await h.connect.view()).problem).toBe('too_large')
    const fsImpl = { ...(await import('node:fs/promises')).default, open: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    expect((await harness({ fsImpl }).connect.view()).problem).toBe('unreadable')
  })
})

describe('forget', () => {
  it('removes the hub, clears active, keeps unknown fields and goes local', async () => {
    const h = harness()
    const { id } = idOf(await h.connect.connect({ address: HOST, code: CODE }))
    const store = readStore(h.filePath)
    writeStore(h.filePath, { ...store, future: 1 })
    expect(h.connect.deviceHeaderFor(`${ORIGIN}/api/items`)).toBe(SECRET)
    expect(await h.connect.forget(id)).toEqual({ ok: true })
    expect(readStore(h.filePath)).toEqual({ schema: 1, active: null, hubs: {}, future: 1 })
    expect(h.connect.connection()).toEqual({ mode: 'local' })
    expect(h.connect.deviceHeaderFor(`${ORIGIN}/api/items`)).toBeNull()
    expect((await h.connect.view()).hub).toBeNull()
  })

  it('refuses a bad id and an unknown one', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    expect(await h.connect.forget('nope')).toEqual({ ok: false, reason: 'bad_id' })
    expect(await h.connect.forget(ID_B)).toEqual({ ok: false, reason: 'not_found' })
    expect(readStore(h.filePath).active).toBe(ID_A)
  })

  it('removes a hub from a file whose other entry fails the rules', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry(), [ID_B]: entry({ device: 'bad' }) } })
    expect(await h.connect.forget(ID_A)).toEqual({ ok: true })
    expect(readStore(h.filePath)).toMatchObject({ active: null, hubs: { [ID_B]: { device: 'bad' } } })
  })

  it('never writes a newer schema or a file that is not JSON, and still stops using the hub', async () => {
    const h = harness()
    writeStore(h.filePath, '{')
    expect(await h.connect.forget(ID_A)).toEqual({ ok: false, reason: 'not_json' })
    expect(readFileSync(h.filePath, 'utf8')).toBe('{')
    writeStore(h.filePath, { schema: 2, active: ID_A, hubs: {} })
    const before = readFileSync(h.filePath, 'utf8')
    expect(await h.connect.forget(ID_A)).toEqual({ ok: false, reason: 'newer_schema' })
    expect(readFileSync(h.filePath, 'utf8')).toBe(before)
  })

  it('treats a missing file as nothing to forget', async () => {
    expect(await harness().connect.forget(ID_A)).toEqual({ ok: true })
  })
})

// ── using the secret ───────────────────────────────────────────────────────────

/** The id of a connect that succeeded. */
function idOf(result: Awaited<ReturnType<ReturnType<typeof createRemoteConnect>['connect']>>): { id: string } {
  if (!result.ok) throw new Error(`connect failed: ${result.reason}`)
  return { id: result.id }
}

/** A harness already paired and online. */
async function connected(options: HarnessOptions = {}) {
  const h = harness(options)
  const result = await h.connect.connect({ address: HOST, code: CODE })
  expect(result.ok).toBe(true)
  return { ...h, id: idOf(result).id }
}

// #617 PR 4b: the Open desk command is stored per hub, and only after the native dialog's Save
describe('setDeskCommand', () => {
  const COMMAND = 'ssh -t studio {attach}'

  it('stores a valid command only after the dialog answered Save, and shows it in view() and storedHub()', async () => {
    const asked: string[] = []
    const h = await connected({ confirmDeskCommand: (command) => { asked.push(command); return true } })
    expect(await h.connect.setDeskCommand({ id: h.id, command: COMMAND })).toEqual({ ok: true })
    expect(asked).toEqual([COMMAND])
    expect(readStore(h.filePath).hubs[h.id]!.deskCommand).toBe(COMMAND)
    expect((await h.connect.view()).hub?.deskCommand).toBe(COMMAND)
    expect(await h.connect.storedHub()).toEqual({ id: h.id, machine: 'studio', deskCommand: COMMAND })
  })

  it('stores nothing when the dialog is cancelled, throws, answers something that is not true, or is not there', async () => {
    for (const confirm of [() => false, () => { throw new Error('closed') }, () => 'yes', async () => 1, undefined]) {
      const h = await connected(confirm ? { confirmDeskCommand: confirm } : {})
      expect(await h.connect.setDeskCommand({ id: h.id, command: COMMAND })).toEqual({ ok: false, reason: 'cancelled' })
      expect(readStore(h.filePath).hubs[h.id]!).not.toHaveProperty('deskCommand')
      expect((await h.connect.view()).hub?.deskCommand).toBeNull()
    }
  })

  it('removes the command with an empty one, without asking', async () => {
    let answer = true
    const confirm = vi.fn(() => answer)
    const h = await connected({ confirmDeskCommand: confirm })
    await h.connect.setDeskCommand({ id: h.id, command: COMMAND })
    answer = false
    expect(await h.connect.setDeskCommand({ id: h.id, command: '' })).toEqual({ ok: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(readStore(h.filePath).hubs[h.id]!).not.toHaveProperty('deskCommand')
    expect(await h.connect.storedHub()).toEqual({ id: h.id, machine: 'studio', deskCommand: null })
  })

  it('never shows the dialog for an invalid command, a wrong id or a request that is not { id, command }', async () => {
    const confirm = vi.fn(() => true)
    const h = await connected({ confirmDeskCommand: confirm })
    for (const command of ['ssh studio', 'ssh {host} {attach}', 'a {desk} }', 'a\n{desk}', 'x'.repeat(509) + '{desk}']) {
      expect(await h.connect.setDeskCommand({ id: h.id, command }), command).toEqual({ ok: false, reason: 'bad_command' })
    }
    expect(await h.connect.setDeskCommand({ id: 'ffffffff', command: COMMAND })).toEqual({ ok: false, reason: 'not_found' })
    expect(await h.connect.setDeskCommand({ id: 'ffffffff', command: '' })).toEqual({ ok: false, reason: 'not_found' })
    for (const input of [null, 'x', { id: h.id }, { command: COMMAND }, { id: 7, command: COMMAND }, { id: h.id, command: 7 }, { id: 'ZZ', command: COMMAND }]) {
      expect(await h.connect.setDeskCommand(input), JSON.stringify(input)).toEqual({ ok: false, reason: 'bad_request' })
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(readStore(h.filePath).hubs[h.id]!).not.toHaveProperty('deskCommand')
  })

  it('saves nothing when the hub changed while the dialog was open', async () => {
    let release!: (value: boolean) => void
    const h = await connected({ confirmDeskCommand: () => new Promise<boolean>((resolve) => { release = resolve }) })
    const pending = h.connect.setDeskCommand({ id: h.id, command: COMMAND })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await h.connect.forget(h.id)).toEqual({ ok: true })
    release(true)
    expect(await pending).toEqual({ ok: false, reason: 'not_found' })
  })

  it('reads a stored command that fails its rule as none, and the hub stays valid', async () => {
    const h = await connected()
    const doc = readStore(h.filePath)
    for (const bad of ['ssh {host} {attach}', 'no placeholder', 'a\n{desk}', 7, '', 'x'.repeat(513)]) {
      writeFileSync(h.filePath, JSON.stringify({ ...doc, hubs: { [h.id]: { ...doc.hubs[h.id], deskCommand: bad } } }), { mode: 0o600 })
      const view = await h.connect.view()
      expect(view.problem, JSON.stringify(bad)).toBeNull()
      expect(view.hub).toMatchObject({ id: h.id, deskCommand: null })
      expect(await h.connect.storedHub()).toEqual({ id: h.id, machine: 'studio', deskCommand: null })
    }
  })

  it('keeps the command through the first probe’s machine record and through a later write', async () => {
    let machine: unknown = null
    const fetch = fakeFetch({ pair: pairOk, version: () => json({ current: '2.12.0', mode: 'release', machine }) })
    const h = await connected({ fetch, confirmDeskCommand: () => true })
    expect(readStore(h.filePath).hubs[h.id]!.machine).toBeNull()
    expect(await h.connect.setDeskCommand({ id: h.id, command: COMMAND })).toEqual({ ok: true })
    machine = 'studio'
    await h.connect.probeHub()
    expect(readStore(h.filePath).hubs[h.id]).toMatchObject({ machine: 'studio', label: 'studio', deskCommand: COMMAND })
    expect(await h.connect.setDeskCommand({ id: h.id, command: 'mydesk studio {desk}' })).toEqual({ ok: true })
    expect(readStore(h.filePath).hubs[h.id]).toMatchObject({ machine: 'studio', deskCommand: 'mydesk studio {desk}' })
  })

  it('a new pairing makes a new entry without the command', async () => {
    const h = await connected({ confirmDeskCommand: () => true })
    await h.connect.setDeskCommand({ id: h.id, command: COMMAND })
    const again = await h.connect.connect({ address: HOST, code: CODE, replace: true })
    const id = idOf(again).id
    expect(readStore(h.filePath).hubs[id]!).not.toHaveProperty('deskCommand')
    expect((await h.connect.view()).hub?.deskCommand).toBeNull()
  })
})

describe('deviceHeaderFor', () => {
  it('answers the secret for the hub’s exact origin, and for its default port', async () => {
    const { connect } = await connected()
    for (const url of [`${ORIGIN}/`, `${ORIGIN}/api/items?scope=attention`, `${ORIGIN}`, `${ORIGIN}:443/x`, new URL(`${ORIGIN}/api/version`)]) {
      expect(connect.deviceHeaderFor(url), String(url)).toBe(SECRET)
    }
  })

  it('reads a host written in another case as the same origin, as the URL parser does', async () => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor('https://HUB.Example.ts.net/api/items')).toBe(SECRET)
  })

  it.each([
    ['http:', `http://${HOST}/api/items`],
    ['another port', `https://${HOST}:8443/api/items`],
    ['port 80', `https://${HOST}:80/`],
    ['a sub-domain', `https://a.${HOST}/`],
    ['the name as a prefix', `https://${HOST}.evil.example/`],
    ['the name as a prefix, as the brief writes it', 'https://hub.example.ts.net.evil.example/api/items'],
    ['the name as a suffix', `https://evil${HOST}/`],
    ['a look-alike with a dash', `https://hub-${SUFFIX.replace('.', '-')}.ts.net/`],
    ['another peer', `https://exit-1.${SUFFIX}/`],
    ['user info', `https://owner@${HOST}/`],
    ['a user and password', `https://owner:pw@${HOST}/`],
    ['an empty user and password', `https://:@${HOST}/`],
    ['a trailing dot', `https://${HOST}./`],
    ['ws:', `wss://${HOST}/`],
    ['a blob URL', `blob:${ORIGIN}/0f0f`],
    ['a data URL', 'data:text/html,hi'],
    ['not a URL', 'hub.example.ts.net/api'],
    ['empty', ''],
  ])('answers nothing for %s', async (_label, url) => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor(url)).toBeNull()
  })

  it.each([undefined, null, 42, {}, { href: `${ORIGIN}/` }])('answers nothing for the non-URL %j', async (url) => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor(url)).toBeNull()
  })

  it('answers nothing with no hub', () => {
    expect(harness().connect.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('answers nothing for a URL object that carries user info', async () => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor(new URL(`https://owner@${HOST}/api/items`))).toBeNull()
    expect(connect.deviceHeaderFor(new URL(`https://owner:pw@${HOST}/api/items`))).toBeNull()
  })
})

describe('hubFetch', () => {
  it('adds the header, forces redirect: error and a timeout, and replaces any device header the caller set', async () => {
    const h = await connected()
    const fetch = h.connect.hubFetch()
    const caller = new AbortController()
    const response = await fetch(`${ORIGIN}/api/version`, { headers: { 'If-None-Match': 'W/"1"', 'X-Agent-Inbox-Device': 'forged' }, redirect: 'follow', signal: caller.signal })
    expect(response.status).toBe(200)
    const call = h.fetch.calls.at(-1)!
    expect(headerOf(call.init, DEVICE_HEADER)).toBe(SECRET)
    expect(headerOf(call.init, 'If-None-Match')).toBe('W/"1"')
    expect(call.init.redirect).toBe('error')
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
    caller.abort()
    expect(call.init.signal!.aborted).toBe(true)
  })

  it('passes a POST through with its body', async () => {
    const h = await connected()
    await h.connect.hubFetch()(`${ORIGIN}/api/items/x/reply`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{"text":"y"}' })
    const call = h.fetch.calls.at(-1)!
    expect(call.init.method).toBe('POST')
    expect(call.init.body).toBe('{"text":"y"}')
    expect(headerOf(call.init, 'Origin')).toBe(ORIGIN)
  })

  it.each([
    `http://${HOST}/api/version`, `https://${HOST}:8443/api/version`, 'https://hub.example.ts.net.evil.example/api/version',
    `https://owner@${HOST}/api/version`, `https://a.${HOST}/`, 'https://evil.example/',
  ])('refuses %s without calling fetch', async (url) => {
    const h = await connected()
    const before = h.fetch.calls.length
    await expect(h.connect.hubFetch()(url)).rejects.toThrow(/not the hub/)
    expect(h.fetch.calls).toHaveLength(before)
  })

  it('refuses a Request object, whose own headers and URL it would not control', async () => {
    const h = await connected()
    await expect(h.connect.hubFetch()(new Request(`${ORIGIN}/api/version`))).rejects.toThrow(/not the hub/)
  })

  it('never hands back a redirect, even from a fetch that does not refuse one', async () => {
    let redirect: number | null = null
    const fetch = fakeFetch({
      pair: pairOk,
      version: () => (redirect ? new Response(null, { status: redirect, headers: { location: 'https://evil.example/', ...MARKER } }) : json({ current: '2.12.0' })),
    })
    const h = await connected({ fetch })
    for (const status of [301, 302, 303, 307, 308]) {
      redirect = status
      await expect(h.connect.hubFetch()(`${ORIGIN}/api/version`), String(status)).rejects.toThrow(/redirect/)
    }
    expect(fetch.calls.every((call) => call.init.redirect === 'error')).toBe(true)
    // and a probe that meets one is not online
    expect(await h.connect.probeHub()).toEqual({ ok: true, state: 'unreachable', version: null, machine: null })
  })

  it('refuses everything with no hub', async () => {
    const h = harness()
    await expect(h.connect.hubFetch()(`${ORIGIN}/api/version`)).rejects.toThrow(/not the hub/)
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('puts no secret in the error it throws', async () => {
    const h = await connected()
    const error = await h.connect.hubFetch()('https://evil.example/').catch((e: unknown) => e)
    expect(String((error as Error).message)).not.toContain(SECRET)
    expect(JSON.stringify(error)).not.toContain(SECRET)
  })
})

// #617 PR 4a: where main's attention watch for the hub joins its paths
describe('hubBase', () => {
  it('answers the active hub’s origin with a trailing slash, for its id only', async () => {
    const h = await connected()
    expect(h.connect.hubBase(h.id)).toBe(`${ORIGIN}/`)
    expect(h.connect.hubBase('89abcdef')).toBeNull()
    expect(h.connect.hubBase(null)).toBeNull()
  })

  it('answers null with no hub, and once the hub is forgotten', async () => {
    expect(harness().connect.hubBase('0123abcd')).toBeNull()
    const h = await connected()
    await h.connect.forget(h.id)
    expect(h.connect.hubBase(h.id)).toBeNull()
  })
})

describe('probeHub', () => {
  async function probeWith(version: Route) {
    const fetch = fakeFetch({ pair: pairOk, version: versionOk() })
    const h = await connected({ fetch })
    const routes = { version }
    const second = fakeFetch(routes)
    const again = createRemoteConnect({
      filePath: h.filePath, execFile: fakeTailscale({ peers: { raw: peersText() } }), exists: cliExists, fetch: second,
      safeStorage: fakeSafeStorage(), platform: 'darwin', hostname: () => 'laptop', now: () => 0,
    })
    return { result: await again.probeHub(), calls: second.calls, again }
  }

  it('is online for a 200 with the marker and a string current, and keeps a good machine', async () => {
    expect((await probeWith(versionOk('2.13.0', 'studio'))).result).toEqual({ ok: true, state: 'online', version: '2.13.0', machine: 'studio' })
  })

  it('drops a machine that fails the place-name rule', async () => {
    for (const machine of ['-studio', 'a b', 'x'.repeat(65), 42, '']) {
      expect((await probeWith(versionOk('2.13.0', machine))).result, String(machine)).toEqual({ ok: true, state: 'online', version: '2.13.0', machine: null })
    }
    expect((await probeWith(() => json({ current: '2.13.0' }))).result).toEqual({ ok: true, state: 'online', version: '2.13.0', machine: null })
  })

  it('is refused for a 403', async () => {
    expect((await probeWith(() => new Response('Forbidden', { status: 403 }))).result).toEqual({ ok: true, state: 'refused', version: null, machine: null })
  })

  it.each([
    ['a refused connection', () => { throw REFUSED_SOCKET() }],
    ['a timeout', () => { throw TIMEOUT() }],
    ['a certificate error', () => { throw SELF_SIGNED() }],
  ])('is unreachable for %s', async (_label, version) => {
    expect((await probeWith(version as Route)).result).toEqual({ ok: true, state: 'unreachable', version: null, machine: null })
  })

  it.each([
    ['a 200 without the marker', () => json({ current: '2.13.0', machine: 'studio' }, 200, {})],
    ['a 502 from Serve', () => new Response('Bad Gateway', { status: 502 })],
    ['a 500 with the marker', () => json({ current: '2.13.0' }, 500)],
    ['a 404', () => new Response('', { status: 404, headers: MARKER })],
    ['no current', () => json({ machine: 'studio' })],
    ['a numeric current', () => json({ current: 2 })],
    ['an empty current', () => json({ current: '' })],
    ['a current with a newline', () => json({ current: '2.13.0\n' })],
    ['a very long current', () => json({ current: '1'.repeat(65) })],
    ['not JSON', () => json('<html>')],
    ['a list', () => json([])],
    ['a body over 64 KiB', () => json({ current: '2.13.0', pad: 'x'.repeat(64 * 1024) })],
  ])('is not_agent_inbox for %s', async (_label, version) => {
    expect((await probeWith(version as Route)).result).toEqual({ ok: true, state: 'not_agent_inbox', version: null, machine: null })
  })

  it('sends GET /api/version through hubFetch: the header, no redirect, a timeout', async () => {
    const { calls } = await probeWith(versionOk())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/version`)
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET')
    expect(headerOf(calls[0]!.init, DEVICE_HEADER)).toBe(SECRET)
    expect(calls[0]!.init.redirect).toBe('error')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers no_hub with no hub', async () => {
    expect(await harness().connect.probeHub()).toEqual({ ok: false, reason: 'no_hub' })
  })
})

// ── the node behind the name ──────────────────────────────────────────────────

describe('the node check before the first probe', () => {
  /** A second app start on a paired store: the peer list as given, a counting fetch. */
  async function restart(peers: PeerOptions | (() => unknown), options: { safeStorage?: ReturnType<typeof fakeSafeStorage>; exists?: (path: string) => boolean } = {}) {
    const first = await connected()
    const fetch = fakeFetch({ version: versionOk() })
    const execFile = fakeTailscale({ peers: typeof peers === 'function' ? (() => peers()) as never : { raw: peersText(peers) } })
    const again = createRemoteConnect({
      filePath: first.filePath, execFile, exists: options.exists ?? cliExists, fetch, safeStorage: options.safeStorage ?? fakeSafeStorage(),
      platform: 'darwin', hostname: () => 'laptop', now: () => 0, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    })
    return { again, fetch, execFile, id: first.id }
  }

  it('sends the probe only after the same node is found', async () => {
    const { again, fetch, execFile } = await restart({})
    expect(await again.probeHub()).toMatchObject({ ok: true, state: 'online' })
    expect(execFile.calls).toHaveLength(1)
    expect(fetch.calls).toHaveLength(1)
  })

  it('sends nothing, clears the secret and is refused (node_changed) when another node holds the name', async () => {
    const { again, fetch } = await restart({ hub: { ID: 'nSomeoneElseCNTRL' } })
    expect(await again.probeHub()).toEqual({ ok: false, reason: 'node_changed' })
    expect(fetch.calls).toHaveLength(0)
    expect(again.connection()).toMatchObject({ mode: 'hub', state: 'refused', reason: 'node_changed' })
    expect(again.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    await expect(again.hubFetch()(`${ORIGIN}/api/version`)).rejects.toThrow(/not the hub/)
  })

  it.each([
    ['tagged now', { hub: { Tags: ['tag:server'] } }, 'tagged_device'],
    ['another user’s now', { hub: { UserID: OTHER_USER } }, 'not_your_device'],
    ['gone', { hub: null }, 'not_found'],
    ['this Mac tagged', { self: { Tags: ['tag:laptop'] } }, 'tagged_self'],
    ['this Mac in another tailnet', { top: { MagicDNSSuffix: 'other.ts.net' } }, 'not_in_tailnet'],
  ])('sends nothing and is refused when the hub is %s', async (_label, peers, reason) => {
    const { again, fetch } = await restart(peers)
    expect(await again.probeHub()).toEqual({ ok: false, reason })
    expect(fetch.calls).toHaveLength(0)
    expect(again.connection()).toMatchObject({ state: 'refused', reason })
    expect(again.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it.each([
    ['the command line is missing', { exists: () => false }, 'no_cli'],
    ['the command fails', { peers: () => ({ error: Object.assign(new Error('Command failed'), { code: 1 }) }) }, 'failed'],
    ['the backend is stopped', { peers: { top: { BackendState: 'Stopped' } } }, 'not_running'],
  ])('sends nothing and is retrying when %s: never the secret on a guess', async (_label, setup, reason) => {
    const { peers, exists } = setup as { peers?: PeerOptions | (() => unknown); exists?: (path: string) => boolean }
    const { again, fetch } = await restart(peers ?? {}, { exists })
    expect(await again.probeHub()).toEqual({ ok: false, reason })
    expect(fetch.calls).toHaveLength(0)
    expect(again.connection()).toMatchObject({ state: 'retrying', reason })
    expect(again.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('sends nothing when the stored secret cannot be decrypted', async () => {
    const broken = { ...fakeSafeStorage(), decryptString: () => { throw new Error('Keychain item missing') } }
    const { again, fetch } = await restart({}, { safeStorage: broken as never })
    expect(await again.probeHub()).toEqual({ ok: false, reason: 'secret_unreadable' })
    expect(fetch.calls).toHaveLength(0)
    expect(again.connection()).toMatchObject({ state: 'refused', reason: 'secret_unreadable' })
  })

  it('sends nothing when the Keychain is not available on a later start', async () => {
    const { again, fetch } = await restart({}, { safeStorage: fakeSafeStorage(false) })
    expect(await again.probeHub()).toEqual({ ok: false, reason: 'no_keychain' })
    expect(fetch.calls).toHaveLength(0)
    expect(again.connection()).toMatchObject({ state: 'retrying', reason: 'no_keychain' })
  })

  it('decrypts once per connection state, not per request', async () => {
    const safeStorage = fakeSafeStorage()
    const { again } = await restart({}, { safeStorage })
    await again.probeHub()
    for (let i = 0; i < 50; i += 1) again.deviceHeaderFor(`${ORIGIN}/api/items`)
    await again.probeHub()
    expect(safeStorage.calls.decrypt).toBe(1)
  })
})

// ── the connection state ──────────────────────────────────────────────────────

interface AppOptions {
  version?: (n: number) => Response | Promise<Response>
  peers?: () => unknown
  safeStorage?: ReturnType<typeof fakeSafeStorage>
}

/**
 * A stand-in for execFile whose `status --json` answer may be a promise, so a test can hold a peer
 * read open: `{ raw }`, `{ error }`, or a promise of either.
 */
function heldTailscale(answer: () => unknown) {
  const calls: string[][] = []
  const fn = (file: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push([...args])
    tailscaleCalls.push({ file, args: [...args], options })
    void Promise.resolve(answer()).then((given) => {
      const a = given as { raw?: string; error?: Error }
      if (a && a.error) callback(a.error, '', '')
      else callback(null, a && typeof a.raw === 'string' ? a.raw : JSON.stringify(a), '')
    })
  }
  return Object.assign(fn, { calls })
}

/** Waits, a few milliseconds at a time, until `ready()` holds. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}

/** The app started again on a paired store, with a clock, recorded timers and the times each check and probe ran. */
async function app(options: AppOptions = {}) {
  const first = await connected()
  const clock = { t: 1_000_000 }
  const t0 = clock.t
  const checkTimes: number[] = []
  const fetchTimes: number[] = []
  let peers = options.peers ?? (() => ({ raw: peersText() }))
  let version = options.version ?? (() => json({ current: '2.12.0', machine: 'studio' }))
  let n = 0
  const execFile = heldTailscale(() => { checkTimes.push(clock.t - t0); return peers() })
  const fetch = fakeFetch({ pair: pairOk, version: () => { fetchTimes.push(clock.t - t0); n += 1; return version(n) } })
  const timers: { fn: () => void; ms: number }[] = []
  let cleared = 0
  let reloads = 0
  const events: Record<string, unknown>[] = []
  const safeStorage = options.safeStorage ?? fakeSafeStorage()
  const rc = createRemoteConnect({
    filePath: first.filePath, execFile, exists: cliExists, fetch, safeStorage, platform: 'darwin', hostname: () => 'laptop',
    now: () => clock.t,
    setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return { unref() {} } },
    clearInterval: () => { cleared += 1 },
    onReload: () => { reloads += 1 },
  })
  const unsubscribe = rc.onConnection((c: Record<string, unknown>) => events.push(c))
  /** Moves the clock in one-second steps up to `ms`, ticking at each. */
  async function run(ms: number) {
    const end = clock.t + ms
    while (clock.t < end) {
      clock.t += 1000
      await rc.tick()
    }
  }
  return {
    rc, clock, execFile, fetch, timers, events, checkTimes, fetchTimes, safeStorage, id: first.id, filePath: first.filePath, run, unsubscribe,
    cleared: () => cleared, reloads: () => reloads,
    setPeers: (next: () => unknown) => { peers = next },
    setVersion: (next: (n: number) => Response | Promise<Response>) => { version = next },
  }
}

describe('the connection state', () => {
  it('is local with no hub, and start() then runs no command and no request', async () => {
    const h = harness()
    expect(h.connect.connection()).toEqual({ mode: 'local' })
    await h.connect.start()
    await h.connect.tick()
    expect(h.connect.connection()).toEqual({ mode: 'local' })
    expect(h.execFile.calls).toHaveLength(0)
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('start() checks the node, then probes, then answers online; the timer is set once', async () => {
    const a = await app()
    await a.rc.start()
    await a.rc.start()
    expect(a.timers).toHaveLength(1)
    expect(a.timers[0]!.ms).toBeLessThanOrEqual(1000)
    expect(a.checkTimes).toEqual([0])
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toEqual({ mode: 'hub', id: a.id, label: 'studio', state: 'online', reason: null, version: '2.12.0' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/api/items`)).toBe(SECRET)
  })

  it('probes every 60 seconds while online, checking the node before every probe', async () => {
    const a = await app()
    await a.rc.start()
    await a.run(130_000)
    expect(a.fetchTimes).toEqual([0, 60_000, 120_000])
    expect(a.checkTimes).toEqual([0, 60_000, 120_000])
  })

  it('a node that moves while online is caught at the next probe: nothing sent, the header withheld, the secret dropped', async () => {
    const a = await app()
    await a.rc.start()
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBe(SECRET)
    a.setPeers(() => ({ raw: peersText({ hub: { ID: 'nSomeoneElseCNTRL' } }) }))
    await a.run(60_000)
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toMatchObject({ state: 'refused', reason: 'node_changed' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    a.setPeers(() => ({ raw: peersText() }))
    await a.run(60_000)
    expect(a.safeStorage.calls.decrypt).toBe(2)
  })

  it('backs off from 2 seconds, doubling to 60, checking the node before each try', async () => {
    const a = await app({ version: () => { throw REFUSED_SOCKET() } })
    await a.rc.start()
    await a.run(190_000)
    expect(a.fetchTimes).toEqual([0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000, 182_000])
    expect(a.checkTimes).toEqual(a.fetchTimes)
    expect(a.rc.connection()).toMatchObject({ state: 'retrying', reason: 'unreachable' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('backs off the same way for an answer that is not an Agent Inbox', async () => {
    const a = await app({ version: () => new Response('Bad Gateway', { status: 502 }) })
    await a.rc.start()
    await a.run(15_000)
    expect(a.fetchTimes).toEqual([0, 2_000, 6_000, 14_000])
    expect(a.rc.connection()).toMatchObject({ state: 'retrying', reason: 'not_agent_inbox' })
  })

  it('retries a 403 every 60 seconds, as refused', async () => {
    const a = await app({ version: () => new Response('Forbidden', { status: 403 }) })
    await a.rc.start()
    await a.run(125_000)
    expect(a.fetchTimes).toEqual([0, 60_000, 120_000])
    expect(a.rc.connection()).toMatchObject({ state: 'refused', reason: 'refused' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('kick() resets the backoff, checks the node again and probes at once', async () => {
    const a = await app({ version: () => { throw REFUSED_SOCKET() } })
    await a.rc.start()
    await a.run(20_000)
    expect(a.fetchTimes).toEqual([0, 2_000, 6_000, 14_000])
    await a.rc.kick()
    expect(a.fetchTimes.at(-1)).toBe(20_000)
    await a.run(10_000)
    // the first retry after a kick is 2 seconds again
    expect(a.fetchTimes).toEqual([0, 2_000, 6_000, 14_000, 20_000, 22_000, 26_000])
  })

  it('kick() while online checks the node before the next request, and holds the header until then', async () => {
    const a = await app()
    await a.rc.start()
    expect(a.checkTimes).toEqual([0])
    const kicked = a.rc.kick()
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    await kicked
    expect(a.checkTimes).toEqual([0, 0])
    expect(a.fetchTimes).toEqual([0, 0])
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBe(SECRET)
  })

  it('a node changed behind the name after a kick sends nothing, clears the secret, and recovers only for the stored node', async () => {
    const a = await app()
    await a.rc.start()
    a.setPeers(() => ({ raw: peersText({ hub: { ID: 'nSomeoneElseCNTRL' } }) }))
    await a.rc.kick()
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toMatchObject({ state: 'refused', reason: 'node_changed' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    // checked again every 60 seconds, still sending nothing
    await a.run(125_000)
    expect(a.fetchTimes).toEqual([0])
    expect(a.checkTimes).toEqual([0, 0, 60_000, 120_000])
    // the stored node is back: the secret is decrypted again and the probe goes
    a.setPeers(() => ({ raw: peersText() }))
    await a.run(60_000)
    expect(a.fetchTimes).toEqual([0, 180_000])
    expect(a.safeStorage.calls.decrypt).toBe(2)
    expect(a.rc.connection()).toMatchObject({ state: 'online' })
  })

  it('sends nothing and backs off while Tailscale cannot be read', async () => {
    const a = await app({ peers: () => ({ error: Object.assign(new Error('Command failed'), { code: 1 }) }) })
    await a.rc.start()
    await a.run(15_000)
    expect(a.fetchTimes).toEqual([])
    expect(a.checkTimes).toEqual([0, 2_000, 6_000, 14_000])
    expect(a.rc.connection()).toMatchObject({ state: 'retrying', reason: 'failed' })
  })

  it('calls onConnection once per change, never for the same answer, and stops after unsubscribe', async () => {
    const a = await app()
    await a.rc.start()
    expect(a.events.map((e) => [e.state, e.reason])).toEqual([['retrying', 'connecting'], ['online', null]])
    await a.run(130_000)
    expect(a.events).toHaveLength(2)
    a.setVersion(() => { throw REFUSED_SOCKET() })
    await a.run(60_000)
    expect(a.events.map((e) => [e.state, e.reason])).toEqual([['retrying', 'connecting'], ['online', null], ['retrying', 'unreachable']])
    a.unsubscribe()
    a.setVersion(() => json({ current: '2.12.0' }))
    await a.run(5_000)
    expect(a.rc.connection()).toMatchObject({ state: 'online' })
    expect(a.events).toHaveLength(3)
  })

  it('a callback that throws stops nothing', async () => {
    const a = await app()
    a.rc.onConnection(() => { throw new Error('page gone') })
    await a.rc.start()
    expect(a.rc.connection()).toMatchObject({ state: 'online' })
    expect(a.events).toHaveLength(2)
  })

  it('calls onReload once when the version changes between two online probes, and not on the first', async () => {
    const versions = ['2.12.0', '2.12.0', '2.13.0', '2.13.0', '2.13.0']
    const a = await app({ version: (n) => json({ current: versions[Math.min(n, versions.length) - 1] }) })
    await a.rc.start()
    expect(a.reloads()).toBe(0)
    await a.run(60_000)
    expect(a.reloads()).toBe(0)
    await a.run(60_000)
    expect(a.reloads()).toBe(1)
    await a.run(120_000)
    expect(a.reloads()).toBe(1)
    expect(a.rc.connection()).toMatchObject({ state: 'online', version: '2.13.0' })
  })

  it('compares with the last online version across a failed probe', async () => {
    const answers: (() => Response)[] = [() => json({ current: '2.12.0' }), () => { throw REFUSED_SOCKET() }, () => json({ current: '2.13.0' })]
    const a = await app({ version: (n) => answers[Math.min(n, answers.length) - 1]!() })
    await a.rc.start()
    await a.run(62_000)
    expect(a.rc.connection()).toMatchObject({ state: 'online', version: '2.13.0' })
    expect(a.reloads()).toBe(1)
  })

  it('never runs two probes at once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const a = await app({ version: async () => { await gate; return json({ current: '2.12.0' }) } })
    const started = a.rc.start()
    const others = [a.rc.tick(), a.rc.kick(), a.rc.probeHub(), a.rc.tick()]
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(a.fetch.calls).toHaveLength(1)
    release()
    await Promise.all([started, ...others])
    expect(a.fetch.most()).toBe(1)
  })

  it('stop() ends everything: the timer, the secret, the probes and the callbacks', async () => {
    const a = await app()
    await a.rc.start()
    a.rc.stop()
    expect(a.cleared()).toBe(1)
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    await expect(a.rc.hubFetch()(`${ORIGIN}/api/version`)).rejects.toThrow(/not the hub/)
    const events = a.events.length
    await a.run(130_000)
    await a.rc.kick()
    expect(a.fetchTimes).toEqual([0])
    expect(a.events).toHaveLength(events)
  })

  it('stop() drops the result of a probe already in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const a = await app({ version: async () => { await gate; return json({ current: '2.12.0' }) } })
    const started = a.rc.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    a.rc.stop()
    release()
    await started
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    expect(a.rc.connection()).toMatchObject({ state: 'retrying', reason: 'stopped' })
  })

  it('forget() stops the retries', async () => {
    const a = await app({ version: () => { throw REFUSED_SOCKET() } })
    await a.rc.start()
    expect(await a.rc.forget(a.id)).toEqual({ ok: true })
    const checks = a.checkTimes.length
    await a.run(130_000)
    expect(a.fetchTimes).toEqual([0])
    expect(a.checkTimes).toHaveLength(checks)
    expect(a.rc.connection()).toEqual({ mode: 'local' })
    expect(a.events.at(-1)).toEqual({ mode: 'local' })
  })

  it('forget() of a file it cannot write still stops using the hub', async () => {
    const a = await app()
    await a.rc.start()
    const store = readStore(a.filePath)
    // a newer schema written by another build: forget cannot write it
    writeStore(a.filePath, { ...store, schema: 2 })
    expect(await a.rc.forget(a.id)).toEqual({ ok: false, reason: 'newer_schema' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    writeStore(a.filePath, store)
    await a.run(130_000)
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toEqual({ mode: 'local' })
  })

  it('connection() never holds the secret, the device id or the node id', async () => {
    const a = await app()
    await a.rc.start()
    const text = JSON.stringify([a.rc.connection(), a.events])
    for (const value of [...secretForms(), DEVICE, NODE]) expect(text).not.toContain(value)
  })

  it('a stored hub replaced on disk by another pairing starts a new connection state', async () => {
    const a = await app()
    await a.rc.start()
    const store = readStore(a.filePath)
    const moved = { ...store.hubs[a.id], node: 'nAnotherPairingCNTRL' }
    writeStore(a.filePath, { ...store, hubs: { [a.id]: moved } })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBe(SECRET)
    await a.run(60_000)
    // the file now names another node than the one behind the name: nothing is sent
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toMatchObject({ state: 'refused', reason: 'node_changed' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })
})

// ── nothing rejects, nothing leaks ────────────────────────────────────────────

describe('no operation rejects', () => {
  const throwing = () => { throw new Error(`boom ${SECRET}`) }

  it('with a file system that throws everywhere', async () => {
    const fsImpl = new Proxy({}, { get: () => async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
    const h = harness({ fsImpl })
    expect(await h.connect.view()).toMatchObject({ hub: null, problem: 'unreadable' })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toMatchObject({ ok: false })
    expect(await h.connect.forget(ID_A)).toMatchObject({ ok: false })
    expect(await h.connect.probeHub()).toMatchObject({ ok: false })
    await h.connect.start()
    await h.connect.tick()
    h.connect.stop()
  })

  it('with an execFile that throws', async () => {
    const h = harness()
    const rc = createRemoteConnect({ filePath: h.filePath, execFile: throwing, exists: cliExists, fetch: h.fetch, safeStorage: fakeSafeStorage(), platform: 'darwin', hostname: () => 'laptop' })
    expect(await rc.findHub(HOST)).toEqual({ ok: false, reason: 'failed' })
    expect(await rc.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'failed' })
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('with an exists check that throws', async () => {
    const h = harness({ exists: throwing as never })
    expect(await h.connect.findHub(HOST)).toEqual({ ok: false, reason: 'no_cli' })
  })

  it('with a fetch that throws something odd or answers nonsense', async () => {
    for (const fetch of [() => { throw null }, () => undefined, () => ({ status: 200 }), () => 'text']) {
      const h = harness({ fetch: fetch as never })
      const result = await h.connect.connect({ address: HOST, code: CODE })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
  })

  it('with a safeStorage whose every method throws', async () => {
    const safeStorage = { isEncryptionAvailable: throwing, encryptString: throwing, decryptString: throwing }
    const h = harness({ safeStorage: safeStorage as never })
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'no_keychain' })
    expect(await h.connect.view()).toMatchObject({ keychain: false })
  })

  it('with a clock, a timer and callbacks that throw', async () => {
    const first = await connected()
    const rc = createRemoteConnect({
      filePath: first.filePath, execFile: fakeTailscale({ peers: { raw: peersText() } }), exists: cliExists, fetch: fakeFetch({ version: versionOk() }),
      safeStorage: fakeSafeStorage(), platform: 'darwin', hostname: throwing, now: throwing, setInterval: throwing, clearInterval: throwing, onReload: throwing,
    })
    rc.onConnection(throwing)
    await rc.start()
    await rc.tick()
    await rc.kick()
    rc.stop()
    expect(rc.onConnection('not a function')).toBeTypeOf('function')
  })

  it('puts no secret, code or body in any answer', async () => {
    const h = await connected()
    const answers = [
      await h.connect.connect({ address: HOST, code: CODE }), await h.connect.probeHub(), await h.connect.view(), h.connect.connection(),
      await h.connect.findHub(HOST), await h.connect.forget(h.id),
    ]
    const text = JSON.stringify(answers)
    for (const value of [...secretForms(), '7K3QX', '9M2PD', 'owner@example.com']) expect(text).not.toContain(value)
  })
})

describe('the source', () => {
  const code = readFileSync(new URL('../electron/remote-connect.cjs', import.meta.url), 'utf8')

  const rules = readFileSync(new URL('../electron/remote-connect-rules.cjs', import.meta.url), 'utf8')

  it('the rules file does no I/O: no command, no network, no file, no log', () => {
    expect(rules).not.toMatch(/console\.|process\.stdout|process\.stderr|child_process|node:fs|fetch\(|runTailscale|(?<![.\w])exec\(/)
    expect(rules.match(/require\(/g)).toHaveLength(1)
    expect(rules).toContain("require('./remote-tailscale.cjs')")
  })

  it('logs nothing and runs no command itself: only the one Tailscale reader, with its peers list', () => {
    expect(code).not.toMatch(/console\.|process\.stdout|process\.stderr/)
    expect(code).not.toMatch(/child_process|execFile\(|\bspawn\b|(?<![.\w])exec\(/)
    expect(code).toContain("runTailscale('peers', deps)")
    expect(code.match(/runTailscale\(/g)).toHaveLength(1)
    expect(code).toContain("require('./remote-tailscale.cjs')")
  })

  it('sends the device header in one place, and the pairing request in another without it', () => {
    expect(code.match(/headers\.set\(DEVICE_HEADER/g)).toHaveLength(1)
    expect(code.match(/fetchImpl\(/g)).toHaveLength(2)
    expect(code.match(/redirect: 'error'/g)).toHaveLength(2)
  })
})


// ── review round 1 ────────────────────────────────────────────────────────────

describe('review round 1: a kick during a node check', () => {
  it('is not lost: the kicked round reads the peers again, and the old list never lets the secret out', async () => {
    let mode: 'ok' | 'hold' | 'moved' = 'ok'
    const pending: ((value: unknown) => void)[] = []
    const a = await app({
      peers: () => (mode === 'hold' ? new Promise((resolve) => pending.push(resolve))
        : mode === 'moved' ? { raw: peersText({ hub: { ID: 'nSomeoneElseCNTRL' } }) } : { raw: peersText() }),
    })
    await a.rc.start()
    expect(a.fetchTimes).toEqual([0])
    mode = 'hold'
    const first = a.rc.kick()
    await until(() => pending.length === 1)
    // the name moves to another node, and a second wake event arrives
    mode = 'moved'
    const second = a.rc.kick()
    // the read that began before the second kick answers with the old list
    pending.shift()!({ raw: peersText() })
    await Promise.all([first, second])
    expect(a.checkTimes).toHaveLength(3)
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    expect(a.rc.connection()).toMatchObject({ state: 'refused', reason: 'node_changed' })
  })
})

describe('review round 1: Tailscale unreadable with the secret in memory', () => {
  it('sends nothing, withholds the header and is retrying', async () => {
    let fail = false
    const a = await app({ peers: () => (fail ? { error: Object.assign(new Error('Command failed'), { code: 1 }) } : { raw: peersText() }) })
    await a.rc.start()
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBe(SECRET)
    fail = true
    await a.rc.kick()
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    expect(a.rc.connection()).toMatchObject({ state: 'retrying', reason: 'failed' })
    // and at the next 60-second probe while online, the same
    fail = false
    await a.rc.kick()
    fail = true
    await a.run(60_000)
    expect(a.fetchTimes).toEqual([0, 0])
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('drops the secret itself, not only the header: it is decrypted again when Tailscale is back', async () => {
    let fail = false
    const a = await app({ peers: () => (fail ? { error: Object.assign(new Error('Command failed'), { code: 1 }) } : { raw: peersText() }) })
    await a.rc.start()
    expect(a.safeStorage.calls.decrypt).toBe(1)
    fail = true
    await a.rc.kick()
    fail = false
    await a.rc.kick()
    expect(a.rc.connection()).toMatchObject({ state: 'online' })
    expect(a.safeStorage.calls.decrypt).toBe(2)
  })
})

describe('review round 1: hubFetch reads its input once', () => {
  it('fetches the very URL it decided on, even from a URL whose href changes between reads', async () => {
    const h = await connected()
    let reads = 0
    class Shifty extends URL {
      override get href() {
        reads += 1
        return reads === 1 ? `${ORIGIN}/api/version` : 'https://evil.example/steal'
      }
    }
    const before = h.fetch.calls.length
    await h.connect.hubFetch()(new Shifty(`${ORIGIN}/`)).catch(() => undefined)
    const sent = h.fetch.calls.slice(before)
    expect(sent.every((call) => call.url.startsWith(`${ORIGIN}/`))).toBe(true)
    expect(sent.map((call) => call.url)).toEqual([`${ORIGIN}/api/version`])
  })

  it('refuses a String object rather than reading it twice', async () => {
    const h = await connected()
    // eslint-disable-next-line no-new-wrappers
    await expect(h.connect.hubFetch()(new String(`${ORIGIN}/api/version`))).rejects.toThrow(/not the hub/)
  })
})

describe('review round 1: user info written in any form', () => {
  const forms = [`https:@${HOST}/`, `https:\\@${HOST}/`, `https:/\\@${HOST}/`, `https:/\t/@${HOST}/`, ` https://@${HOST}/`, `https://hub.exa\nmple.ts.net@${HOST}/`]

  it.each(forms)('deviceHeaderFor refuses %j', async (url) => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor(url)).toBeNull()
  })

  it.each(forms)('hubFetch refuses %j without calling fetch', async (url) => {
    const h = await connected()
    const before = h.fetch.calls.length
    await expect(h.connect.hubFetch()(url)).rejects.toThrow(/not the hub/)
    expect(h.fetch.calls).toHaveLength(before)
  })

  it.each(forms)('parseHubOrigin refuses %j', (url) => {
    expect(parseHubOrigin(url)).toEqual({ ok: false, reason: 'bad_address' })
  })

  it('still gives the header for a path that holds an @', async () => {
    const { connect } = await connected()
    expect(connect.deviceHeaderFor(`${ORIGIN}/api/items/a@b`)).toBe(SECRET)
  })
})

describe('review round 1: stop() stops', () => {
  it('marks the connection stopped, withholds the header and answers stopped to probeHub, kick and tick, sending nothing', async () => {
    const a = await app()
    await a.rc.start()
    a.rc.stop()
    expect(a.rc.connection()).toEqual({ mode: 'hub', id: a.id, label: 'studio', state: 'retrying', reason: 'stopped', version: '2.12.0' })
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    const checks = a.checkTimes.length
    expect(await a.rc.probeHub()).toEqual({ ok: false, reason: 'stopped' })
    expect(await a.rc.kick()).toEqual({ ok: false, reason: 'stopped' })
    expect(await a.rc.tick()).toEqual({ ok: false, reason: 'stopped' })
    await a.run(130_000)
    expect(a.fetchTimes).toEqual([0])
    expect(a.checkTimes).toHaveLength(checks)
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('a probeHub() queued behind a probe when stop() lands sends nothing', async () => {
    let release: () => void = () => {}
    let hold = false
    const a = await app({ version: () => (hold ? new Promise<Response>((resolve) => { release = () => resolve(json({ current: '2.12.0' })) }) : json({ current: '2.12.0' })) })
    await a.rc.start()
    hold = true
    const kicked = a.rc.kick()
    await until(() => a.fetchTimes.length === 2)
    const queued = a.rc.probeHub()
    a.rc.stop()
    release()
    await kicked
    expect(await queued).toEqual({ ok: false, reason: 'stopped' })
    expect(a.fetchTimes).toHaveLength(2)
    expect(a.checkTimes).toHaveLength(2)
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
  })

  it('connect() and forget() still work on the store, but start no probing; start() resumes', async () => {
    const a = await app()
    await a.rc.start()
    a.rc.stop()
    const replaced = await a.rc.connect({ address: HOST, code: CODE, replace: true })
    expect(replaced).toMatchObject({ ok: true, state: 'retrying', reason: 'stopped' })
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    expect(readStore(a.filePath).active).toBe(idOf(replaced).id)
    await a.rc.start()
    expect(a.fetchTimes).toEqual([0, 0])
    expect(a.rc.connection()).toMatchObject({ state: 'online' })
    a.rc.stop()
    expect(await a.rc.forget(idOf(replaced).id)).toEqual({ ok: true })
    expect(readStore(a.filePath).active).toBeNull()
  })

  it.each(['stop', 'forget'] as const)('%s() during a node check: the late check never puts the header back', async (action) => {
    let hold = false
    const pending: ((value: unknown) => void)[] = []
    const a = await app({ peers: () => (hold ? new Promise((resolve) => pending.push(resolve)) : { raw: peersText() }) })
    await a.rc.start()
    hold = true
    const kicked = a.rc.kick()
    await until(() => pending.length === 1)
    if (action === 'stop') a.rc.stop()
    else void a.rc.forget(a.id)
    pending.shift()!({ raw: peersText() })
    await kicked
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(a.rc.deviceHeaderFor(`${ORIGIN}/`)).toBeNull()
    expect(a.fetchTimes).toEqual([0])
    expect(a.rc.connection()).toEqual(action === 'stop'
      ? { mode: 'hub', id: a.id, label: 'studio', state: 'retrying', reason: 'stopped', version: '2.12.0' }
      : { mode: 'local' })
  })
})

describe('review round 1: the store is opened the hub’s way', () => {
  const race = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000))])

  it('reads a FIFO at the path as bad_file, without blocking anything', async () => {
    const h = harness()
    ;(await import('node:child_process')).execFileSync('/usr/bin/mkfifo', [h.filePath])
    expect(await race(h.connect.view())).toEqual({ available: true, keychain: true, hub: null, problem: 'bad_file' })
    expect(await race(h.connect.connect({ address: HOST, code: CODE }))).toEqual({ ok: false, reason: 'bad_file' })
    expect(await race(h.connect.forget(ID_A))).toEqual({ ok: false, reason: 'bad_file' })
    expect(await race(h.connect.probeHub())).toEqual({ ok: false, reason: 'no_hub' })
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('reads a FIFO or a folder with mode 0600 as bad_file: it must be a regular file', async () => {
    const fifo = harness()
    ;(await import('node:child_process')).execFileSync('/usr/bin/mkfifo', [fifo.filePath])
    ;(await import('node:fs')).chmodSync(fifo.filePath, 0o600)
    expect(await race(fifo.connect.view())).toMatchObject({ hub: null, problem: 'bad_file' })
    const folder = harness()
    ;(await import('node:fs')).mkdirSync(folder.filePath, { mode: 0o700 })
    expect(await folder.connect.view()).toMatchObject({ hub: null, problem: 'bad_file' })
  })

  it('reads a symlink to a good store as bad_file, and never follows it', async () => {
    const h = harness()
    const real = join(h.dir, 'real.json')
    writeStore(real, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    ;(await import('node:fs')).symlinkSync(real, h.filePath)
    expect(await h.connect.view()).toMatchObject({ hub: null, problem: 'bad_file' })
    expect(await h.connect.forget(ID_A)).toEqual({ ok: false, reason: 'bad_file' })
    expect(readStore(real).active).toBe(ID_A)
  })

  it('reads a store open to others, a folder, or another user’s file as bad_file', async () => {
    const open = harness()
    writeStore(open.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    ;(await import('node:fs')).chmodSync(open.filePath, 0o644)
    expect(await open.connect.view()).toMatchObject({ hub: null, problem: 'bad_file' })
    const folder = harness()
    ;(await import('node:fs')).mkdirSync(folder.filePath)
    expect(await folder.connect.view()).toMatchObject({ hub: null, problem: 'bad_file' })
    const dir = scratchDir('rc-')
    const filePath = join(dir, 'remote-connect.json')
    writeStore(filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    const other = createRemoteConnect({ filePath, uid: (process.getuid?.() ?? 0) + 1, platform: 'darwin', safeStorage: fakeSafeStorage() })
    expect(await other.view()).toMatchObject({ hub: null, problem: 'bad_file' })
  })

  it('writes over a bad file only on a connect the owner confirmed', async () => {
    const h = harness()
    writeStore(h.filePath, { schema: 1, active: ID_A, hubs: { [ID_A]: entry() } })
    ;(await import('node:fs')).chmodSync(h.filePath, 0o644)
    expect(await h.connect.connect({ address: HOST, code: CODE })).toEqual({ ok: false, reason: 'bad_file' })
    expect(statSync(h.filePath).mode & 0o777).toBe(0o644)
    expect(await h.connect.connect({ address: HOST, code: CODE, replace: true })).toMatchObject({ ok: true, state: 'online' })
    expect(statSync(h.filePath).mode & 0o777).toBe(0o600)
  })
})

describe('review round 1: what the answers say', () => {
  it('says forget_not_saved while a forget could not be written, and saves it at the next operation', async () => {
    const h = await connected()
    const store = readStore(h.filePath)
    writeStore(h.filePath, { ...store, schema: 2 })
    expect(await h.connect.forget(h.id)).toEqual({ ok: false, reason: 'newer_schema' })
    writeStore(h.filePath, store)
    // the file still holds the hub and its secret: say so
    expect(await h.connect.view()).toMatchObject({ hub: null, problem: 'forget_not_saved' })
    // the next operation writes it
    expect(await h.connect.probeHub()).toEqual({ ok: false, reason: 'no_hub' })
    expect(readStore(h.filePath)).toMatchObject({ active: null, hubs: {} })
    expect(await h.connect.view()).toMatchObject({ hub: null, problem: null })
  })

  it('a connect whose hub is forgotten during its probe answers forgotten', async () => {
    let release: () => void = () => {}
    const fetch = fakeFetch({ pair: pairOk, version: () => new Promise((resolve) => { release = () => resolve(json({ current: '2.12.0' })) }) })
    const h = harness({ fetch })
    const connecting = h.connect.connect({ address: HOST, code: CODE })
    await until(() => fetch.calls.length === 2)
    const id = readStore(h.filePath).active!
    const forgetting = h.connect.forget(id)
    release()
    expect(await connecting).toEqual({ ok: false, reason: 'forgotten' })
    expect(await forgetting).toEqual({ ok: true })
    expect(h.connect.connection()).toEqual({ mode: 'local' })
  })

  it('says when a replace leaves this Mac paired on the old hub', async () => {
    const h = await connected()
    const replaced = await h.connect.connect({ address: HOST, code: CODE, replace: true })
    expect(replaced).toMatchObject({ ok: true, replacedHub: true })
    const fresh = await harness().connect.connect({ address: HOST, code: CODE, replace: true })
    expect(fresh.ok && 'replacedHub' in fresh).toBe(false)
  })
})
