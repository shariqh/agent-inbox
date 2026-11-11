// Card signatures (#536; publishable-agent design §3.10, D21, decisions Q3, Q4 and Q6): the
// verifier (src/card-signature.ts: raw JCS, ES256/ES384/EdDSA each over its own listed key type, caps first), our signer
// (packages/mesh/src/card-signing.ts: refuses a card that is not canonical-stable or a key the
// card does not list; each agent reads only its own key files) and `meshctl key` (0600 keys in a
// 0700 folder whatever the umask, never printed). The SDK interop is in
// packages/mesh/test/card-signing.test.ts, where the SDK is installed; add, check and call are in
// test/mesh.test.ts, test/mesh-check.test.ts and test/mesh-call.test.ts.
import { generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../packages/mesh/src/files.js'
import { loadSigningKeys, signCard } from '../packages/mesh/src/card-signing.js'
import { signatureVerdict, verifyCardSignatures } from '../src/card-signature.js'
import { cardSha256, signatureRefusal, signedLine } from '../src/mesh-add.js'
import { runMeshctl } from '../src/meshctl.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { jws, signWith, testKey } from './signed-card.js'

afterEach(() => removeScratchDirs())

type Json = Record<string, any>
const PROFILE = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
const A = testKey()
const B = testKey()
const card = (keys: Json[] = [A.publicJwk], edit: (c: Json) => void = () => {}): Json => {
  const c: Json = {
    name: 'Notes search', description: 'Searches your notes.', version: '1.4.0',
    provider: { organization: 'Example Org', url: 'https://example.org' },
    supportedInterfaces: [{ url: 'http://127.0.0.1:4500/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true, extensions: [{ uri: PROFILE, params: { id: 'example.org/notes-search', keys, skills: { 'search-notes': { egress: 'none', residency: 'any' } } } }] },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: ['call'] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'search-notes', name: 'Search notes', description: 'Search your notes', tags: ['notes'] }],
  }
  edit(c)
  return c
}
const keyOf = (k: typeof A) => ({ kid: k.kid, key: k.key })
const verdict = (c: Json) => signatureVerdict(JSON.parse(JSON.stringify(c)))
const NO_MATCH = 'the card has a signature by a listed key that does not verify'

describe('the verifier (raw JCS, ES256, a listed key)', () => {
  it('a good signature verifies; two listed keys (a rotation) both do', () => {
    expect(verdict(signCard(card(), [keyOf(A)]))).toEqual({ keys: [A.kid], signed: [A.kid], algs: ['ES256'] })
    const both = signCard(card([A.publicJwk, B.publicJwk]), [keyOf(A), keyOf(B)])
    expect(verdict(both)).toEqual({ keys: [A.kid, B.kid], signed: [A.kid, B.kid], algs: ['ES256', 'ES256'] })
    // key order and member order do not matter: JCS
    const reordered = Object.fromEntries(Object.entries(signCard(card(), [keyOf(A)])).reverse())
    expect(verdict(reordered)).toMatchObject({ signed: [A.kid] })
  })

  it('a change to any field fails, auth requirements and the interface URL included', () => {
    const signed = signCard(card(), [keyOf(A)])
    const edits: Array<(c: Json) => void> = [
      (c) => { c.name = 'Notes search 2' },
      (c) => { c.securityRequirements[0].schemes.bearer.list = ['admin'] },
      (c) => { delete c.securityRequirements },
      (c) => { c.securitySchemes.bearer.httpAuthSecurityScheme.scheme = 'Basic' },
      (c) => { c.supportedInterfaces[0].url = 'http://127.0.0.1:4501/a2a' },
      (c) => { c.provider.url = 'https://example.com' },
      (c) => { c.capabilities.extensions[0].params.skills['search-notes'].egress = [{ purpose: 'web', hosts: 'any', sends: 'input' }] },
      (c) => { c.skills[0].tags.push('more') },
      (c) => { c.iconUrl = 'https://example.org/icon.png' },
    ]
    for (const edit of edits) {
      const copy = structuredClone(signed)
      edit(copy)
      expect(verdict(copy), edit.toString()).toEqual({ keys: [A.kid], refused: NO_MATCH })
    }
  })

  it('a signature by a key the card does not list counts as unsigned; one by another key is a card change', () => {
    const byB = signWith(card(), B)
    expect(verdict(byB)).toEqual({ keys: [A.kid], unsigned: 'unlisted' })
    expect(verdict(card())).toEqual({ keys: [A.kid], unsigned: 'absent' })
    // signatures but no keys at all: unsigned too
    expect(verdict(signWith(card([], (c) => { delete c.capabilities.extensions[0].params.keys }), A))).toEqual({ keys: [], unsigned: 'unlisted' })
    // listing and signing with another key verifies, but moves the pin: a card change (#531)
    const swapped = signCard(card([B.publicJwk]), [keyOf(B)])
    expect(verdict(swapped)).toMatchObject({ signed: [B.kid] })
    expect(cardSha256(swapped)).not.toBe(cardSha256(signCard(card(), [keyOf(A)])))
    // a private member in keys breaks the profile, so no key is listed
    expect(verifyCardSignatures(signWith(card([{ ...A.privateJwk }]), A))).toMatchObject({ keys: [], unlisted: 1, valid: [] })
  })

  it('verifies ES256, ES384 and EdDSA, each only over its own key type; refuses none, HS256 and RS256', () => {
    const P384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
    const ED = generateKeyPairSync('ed25519')
    const pub384 = P384.publicKey.export({ format: 'jwk' }) as Json
    const pubEd = ED.publicKey.export({ format: 'jwk' }) as Json
    const KEY384 = { kty: 'EC', crv: 'P-384', x: pub384.x, y: pub384.y }
    const KEYED = { kty: 'OKP', crv: 'Ed25519', x: pubEd.x }
    const both = card([A.publicJwk, KEY384, KEYED])
    const [kidA, kid384, kidEd] = (verifyCardSignatures(both) as { keys: string[] }).keys as [string, string, string]
    expect(kidA).toBe(A.kid)
    const signed = (alg: string, kid: string, key: KeyObject): Json => ({ ...both, signatures: [jws(both, key, { alg, typ: 'JOSE', kid })] })
    // a valid card for each algorithm the profile allows
    expect(verdict(signed('ES384', kid384, P384.privateKey))).toEqual({ keys: [kidA, kid384, kidEd], signed: [kid384], algs: ['ES384'] })
    expect(verdict(signed('EdDSA', kidEd, ED.privateKey))).toEqual({ keys: [kidA, kid384, kidEd], signed: [kidEd], algs: ['EdDSA'] })
    expect(signedLine(verdict(signed('EdDSA', kidEd, ED.privateKey)), 'new')).toBe(`yes, EdDSA key ${kidEd} (new)`)
    expect(verdict(signed('ES256', kidA, A.key))).toEqual({ keys: [kidA, kid384, kidEd], signed: [kidA], algs: ['ES256'] })
    // and tampering breaks each
    for (const [alg, kid, key] of [['ES384', kid384, P384.privateKey], ['EdDSA', kidEd, ED.privateKey]] as const) {
      expect(verdict({ ...signed(alg, kid, key), name: 'Other' }), alg).toMatchObject({ refused: NO_MATCH })
    }
    // an algorithm bound to another key type fails, whatever key made the signature
    const ALG = 'the card has a signature by a listed key whose algorithm is not ES256 over a P-256 key, ES384 over P-384 or EdDSA over Ed25519'
    const mismatches: Array<[string, string, KeyObject]> = [
      ['ES256', kid384, P384.privateKey], ['ES384', kidA, A.key], ['EdDSA', kidA, A.key], ['EdDSA', kid384, P384.privateKey],
      ['ES256', kidEd, ED.privateKey], ['ES384', kidEd, ED.privateKey],
    ]
    for (const [alg, kid, key] of mismatches) expect(verdict(signed(alg, kid, key)), `${alg} over ${kid}`).toMatchObject({ refused: ALG })
    // nothing off the list, for any listed key
    for (const alg of ['none', 'HS256', 'RS256', 'ES512', 'PS256', 'es256']) {
      for (const [kid, key] of [[kidA, A.key], [kidEd, ED.privateKey]] as const) expect(verdict(signed(alg, kid, key)), alg).toMatchObject({ refused: ALG })
    }
    const c = card()
    const signedA = (header: Json, key = A.key): Json => ({ ...c, signatures: [jws(c, key, { typ: 'JOSE', kid: A.kid, ...header })] })
    // the key comes from the signed list, never the header: B's jwk with A's kid, signed by B, fails
    expect(verdict(signedA({ alg: 'ES256', jwk: B.publicJwk }, B.key))).toMatchObject({ refused: NO_MATCH })
    expect(verdict(signedA({ alg: 'ES256', jwk: B.publicJwk, jku: 'https://attacker.example/keys' }))).toMatchObject({ signed: [A.kid] })
    const HEADER = 'the card has a signature whose header meshctl refuses (crit, b64 or x5c, or a typ other than JOSE)'
    for (const extra of [{ crit: ['b64'] }, { b64: false }, { x5c: ['MIIB'] }, { typ: 'JWT' }]) expect(verdict(signedA({ alg: 'ES256', ...extra })), JSON.stringify(extra)).toMatchObject({ refused: HEADER })
    const { typ: _t, ...noTyp } = { typ: 'x', alg: 'ES256', kid: A.kid }
    expect(verdict({ ...c, signatures: [jws(c, A.key, noTyp)] })).toMatchObject({ refused: HEADER })
  })

  it('caps size, depth, count and header size before canonicalising', () => {
    const UNREADABLE = 'the card has signatures meshctl cannot read'
    const deep = signCard(card(), [keyOf(A)])
    deep.deep = JSON.parse(`${'['.repeat(32)}1${']'.repeat(32)}`)
    expect(verdict(deep)).toEqual({ keys: [], refused: 'the card is nested more than 32 deep' })
    // far deeper than any stack: refused by the walk, never recursed into
    let huge: unknown = 1
    for (let i = 0; i < 200_000; i++) huge = [huge]
    expect(signatureVerdict({ ...card(), deep: huge })).toEqual({ keys: [], refused: 'the card is nested more than 32 deep' })
    expect(verdict({ ...signCard(card(), [keyOf(A)]), description: 'd'.repeat(70_000) })).toEqual({ keys: [], refused: 'the card is over 64 KiB' })
    const one = (signCard(card(), [keyOf(A)]) as Json).signatures[0]
    expect(verdict({ ...card(), signatures: [one, one, one, one, one] })).toMatchObject({ refused: UNREADABLE })
    expect(verdict({ ...card(), signatures: [one, one, one, one] })).toMatchObject({ signed: [A.kid, A.kid, A.kid, A.kid] })
    const big = jws(card(), A.key, { alg: 'ES256', typ: 'JOSE', kid: A.kid, pad: 'p'.repeat(2100) })
    expect(verdict({ ...card(), signatures: [big] })).toMatchObject({ refused: UNREADABLE })
    for (const bad of [{ signature: one.signature }, { protected: 'not base64!', signature: one.signature }, { protected: Buffer.from('[1]').toString('base64url'), signature: one.signature },
      { protected: Buffer.from('{"alg":"ES256"}').toString('base64url'), signature: one.signature }]) {
      expect(verdict({ ...card(), signatures: [bad] }), JSON.stringify(bad)).toMatchObject({ refused: UNREADABLE })
    }
    expect(verdict({ ...card(), signatures: { protected: one.protected } })).toMatchObject({ refused: UNREADABLE })
  })

  it('a card signed over another payload fails closed, with the empty-values hint when the card has them', () => {
    const empty = card(undefined, (c) => { c.securityRequirements[0].schemes.bearer.list = [] })
    // the SDK's payload drops the empty list and everything it empties (Appendix A)
    const { securityRequirements: _gone, ...sdkPayload } = empty
    const sdkSigned = { ...empty, signatures: [jws(sdkPayload, A.key, { alg: 'ES256', typ: 'JOSE', kid: A.kid })] }
    expect(verdict(sdkSigned)).toEqual({ keys: [A.kid], refused: `${NO_MATCH}: the card has empty or default values, which A2A signers drop, so its signer may have signed a different payload` })
    // the same card signed over its raw JCS verifies: the verifier has no precondition
    expect(verdict(signWith(empty, A))).toMatchObject({ signed: [A.kid] })
  })

  it('add refuses an unsigned card at the publishable level only, and a --key-thumbprint the signature does not match', () => {
    const signed = verdict(signCard(card(), [keyOf(A)]))
    const unsigned = verdict(card())
    expect([signatureRefusal(unsigned, true, undefined), signatureRefusal(signed, true, undefined), signatureRefusal(signed, false, undefined)]).toEqual([undefined, undefined, undefined])
    expect(signatureRefusal(unsigned, false, undefined)).toBe('the card is not signed by a key it lists, and an agent outside loopback and this Mac\'s tailnet must be')
    expect(signatureRefusal(verdict(signWith(card(), B)), false, undefined)).toBe('the card is not signed by a key it lists, and an agent outside loopback and this Mac\'s tailnet must be')
    expect(signatureRefusal(signed, true, A.kid)).toBeUndefined()
    for (const v of [signed, unsigned]) expect(signatureRefusal(v, true, B.kid)).toBe('the card is not signed by the key --key-thumbprint names')
  })
})

describe('our signer (packages/mesh)', () => {
  it('refuses a card that is not canonical-stable, no key, or a key the card does not list', () => {
    const refused = (c: Json, keys = [keyOf(A)]): string => {
      try {
        signCard(c, keys)
        return 'signed'
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        return (error as Error).message
      }
    }
    expect(refused(card(undefined, (c) => { c.capabilities.extensions[0].required = false }))).toContain('not canonical-stable (required-false)')
    expect(refused(card(undefined, (c) => { c.securityRequirements[0].schemes.bearer.list = [] }))).toContain('not canonical-stable (empty-value)')
    expect(refused(card(undefined, (c) => { c.iconUrl = null }))).toContain('not canonical-stable (null-value)')
    expect(refused(card(undefined, (c) => { c.documentationUrl = '' }))).toContain('not canonical-stable (empty-value)')
    expect(refused(card(), [])).toBe('no signing key')
    expect(refused(card(), [keyOf(B)])).toBe(`the card's profile extension does not list signing key ${B.kid}`)
    // old signatures are replaced, never kept
    const twice = signCard(signCard(card(), [keyOf(A)]), [keyOf(A)])
    expect(twice.signatures).toHaveLength(1)
  })

  it('an agent reads only its own key files, each regular, owned, 0600 and at most 4 KiB, in a 0700 folder', () => {
    const dir = scratchDir('signing-keys-')
    expect(loadSigningKeys(dir, 'echo')).toEqual([])
    expect(ctl(dir, 'key', 'create', 'echo', '--apply').code).toBe(0)
    const keys = join(dir, 'mesh', 'keys')
    const [current] = loadSigningKeys(dir, 'echo')
    expect(ctl(dir, 'key', 'show', 'echo').out).toContain(`Thumbprint ${current!.kid}\n`)
    expect(ctl(dir, 'key', 'rotate', 'echo', '--apply').code).toBe(0)
    const both = loadSigningKeys(dir, 'echo')
    expect(both.map((k) => k.kid)).toEqual([current!.kid, expect.not.stringMatching(current!.kid)])
    // another agent's broken files are never opened
    symlinkSync(join(keys, 'echo.jwk'), join(keys, 'other.jwk'))
    writeFileSync(join(keys, 'other-next.jwk'), 'x', { mode: 0o644 })
    expect(loadSigningKeys(dir, 'echo')).toHaveLength(2)
    const words = (agent: string): string => { try { loadSigningKeys(dir, agent); return 'loaded' } catch (error) { return (error as Error).message } }
    expect(words('other')).toBe(`${join(keys, 'other.jwk')} is a symlink`)
    for (const agent of ['../echo', 'Echo', 'echo-next']) expect(words(agent)).toBe('the agent name must be 1-40 lower-case letters, digits and inner hyphens')
    const secret = JSON.parse(readFileSync(join(keys, 'echo.jwk'), 'utf8')).d as string
    const cases: Array<[string, () => void, string]> = [
      ['0644', () => chmodSync(join(keys, 'echo.jwk'), 0o644), 'must be mode 0600'],
      ['too big', () => writeFileSync(join(keys, 'echo.jwk'), `${' '.repeat(5000)}{}`, { mode: 0o600 }), 'is larger than 4096 bytes'],
      ['public only', () => writeFileSync(join(keys, 'echo.jwk'), JSON.stringify(A.publicJwk), { mode: 0o600 }), 'does not hold one P-256 private JWK'],
      ['another d', () => writeFileSync(join(keys, 'echo.jwk'), JSON.stringify({ ...A.privateJwk, d: B.privateJwk.d }), { mode: 0o600 }), 'does not hold one P-256 private JWK'],
    ]
    for (const [what, edit, expected] of cases) {
      const saved = readFileSync(join(keys, 'echo.jwk'))
      edit()
      expect(words('echo'), what).toContain(expected)
      expect(words('echo')).not.toContain(secret)
      writeFileSync(join(keys, 'echo.jwk'), saved, { mode: 0o600 })
      chmodSync(join(keys, 'echo.jwk'), 0o600)
    }
    chmodSync(keys, 0o755)
    expect(words('echo')).toBe(`${keys} must be a 0700 folder you own`)
  })
})

function ctl(dir: string, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = runMeshctl(argv, { env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', out: (t) => out.push(t), err: (t) => err.push(t) })
  return { code, out: out.join(''), err: err.join('') }
}
const mode = (path: string): string => (lstatSync(path).mode & 0o777).toString(8)

describe('meshctl key create|show|rotate|retire', () => {
  it('create is a dry run, then writes a 0600 key in a 0700 folder whatever the umask, and never prints it', () => {
    for (const umask of [0o000, 0o277]) {
      const dir = scratchDir('meshctl-key-')
      const dry = ctl(dir, 'key', 'create', 'echo')
      expect(dry.code).toBe(0)
      expect(dry.out).toBe(`Dry run.\nWould create ${join(dir, 'mesh', 'keys', 'echo.jwk')} (0600, in a 0700 folder): a new P-256 key that signs echo's card. Its private part is never printed.\nNothing changed. Re-run with --apply.\n`)
      expect(readdirSync(dir)).toEqual([])
      const before = process.umask(umask)
      let made
      try {
        made = ctl(dir, 'key', 'create', 'echo', '--apply')
      } finally {
        process.umask(before)
      }
      expect(made.code, made.err).toBe(0)
      const file = join(dir, 'mesh', 'keys', 'echo.jwk')
      expect([mode(join(dir, 'mesh')), mode(join(dir, 'mesh', 'keys')), mode(file)]).toEqual(['700', '700', '600'])
      const jwk = JSON.parse(readFileSync(file, 'utf8'))
      expect(Object.keys(jwk)).toEqual(['kty', 'crv', 'x', 'y', 'd'])
      const shown = ctl(dir, 'key', 'show', 'echo')
      for (const r of [made, shown]) {
        expect(r.out + r.err).not.toContain(jwk.d)
        expect(r.out).toContain(`Public JWK {"kty":"EC","crv":"P-256","x":"${jwk.x}","y":"${jwk.y}"}\n`)
      }
      const kid = verifyCardSignatures(card([{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }])) as { keys: string[] }
      expect(shown.out).toBe(`Key        ${file} (signs echo's card)\nThumbprint ${kid.keys[0]}\nPublic JWK {"kty":"EC","crv":"P-256","x":"${jwk.x}","y":"${jwk.y}"}\n`)
      expect(ctl(dir, 'key', 'create', 'echo', '--apply').err).toBe(`Refused: echo already has a signing key (${file}): meshctl key rotate echo replaces it. Nothing changed.\n`)
    }
  })

  it('rotate adds a next key; retire makes it the key and drops the old one', () => {
    const dir = scratchDir('meshctl-key-')
    const keys = join(dir, 'mesh', 'keys')
    expect(ctl(dir, 'key', 'rotate', 'echo', '--apply').err).toBe('Refused: echo has no signing key: meshctl key create echo --apply makes one. Nothing changed.\n')
    ctl(dir, 'key', 'create', 'echo', '--apply')
    const first = /Thumbprint (\S+)/.exec(ctl(dir, 'key', 'show', 'echo').out)![1]!
    expect(ctl(dir, 'key', 'retire', 'echo', '--apply').err).toBe('Refused: echo has no next key to retire to: meshctl key rotate echo --apply makes one. Nothing changed.\n')
    expect(ctl(dir, 'key', 'rotate', 'echo').out).toContain('Nothing changed.')
    expect(existsSync(join(keys, 'echo-next.jwk'))).toBe(false)
    const rotated = ctl(dir, 'key', 'rotate', 'echo', '--apply')
    expect(rotated.out).toContain('keep both listed for at least 30 days, then meshctl key retire echo --apply')
    expect(mode(join(keys, 'echo-next.jwk'))).toBe('600')
    const shown = ctl(dir, 'key', 'show', 'echo').out
    const second = [...shown.matchAll(/Thumbprint (\S+)/g)].map((m) => m[1])
    expect(second).toEqual([first, expect.any(String)])
    expect(shown).toContain(`Next key   ${join(keys, 'echo-next.jwk')} (rotation: listed beside the key above, both sign)\n`)
    expect(ctl(dir, 'key', 'rotate', 'echo', '--apply').code).toBe(1)
    const dry = ctl(dir, 'key', 'retire', 'echo')
    expect(dry.out).toContain(`key ${first} stops signing echo's card and ${second[1]} becomes its key`)
    expect(existsSync(join(keys, 'echo-next.jwk'))).toBe(true)
    expect(ctl(dir, 'key', 'retire', 'echo', '--apply').code).toBe(0)
    expect(readdirSync(keys)).toEqual(['echo.jwk'])
    expect([...ctl(dir, 'key', 'show', 'echo').out.matchAll(/Thumbprint (\S+)/g)].map((m) => m[1])).toEqual([second[1]])
  })

  it('refuses a bad name, an open folder and a symlinked or open key file; bad arguments are usage errors', () => {
    const dir = scratchDir('meshctl-key-')
    for (const argv of [['key'], ['key', 'show'], ['key', 'frob', 'echo'], ['key', 'show', 'echo', '--apply'], ['key', 'create', 'echo', '--bogus'], ['key', 'create', '--apply'], ['key', 'create', 'echo', '--apply', '--apply']]) {
      expect(ctl(dir, ...argv).code, argv.join(' ')).toBe(2)
    }
    for (const name of ['Echo', 'echo-next', '../x', 'a'.repeat(41)]) expect(ctl(dir, 'key', 'create', name, '--apply').code, name).toBe(1)
    expect(ctl(dir, 'key', 'show', 'echo').code).toBe(1)
    ctl(dir, 'key', 'create', 'echo', '--apply')
    const keys = join(dir, 'mesh', 'keys')
    const secret = JSON.parse(readFileSync(join(keys, 'echo.jwk'), 'utf8')).d as string
    chmodSync(join(keys, 'echo.jwk'), 0o640)
    expect(ctl(dir, 'key', 'show', 'echo').err).toBe(`Refused: ${join(keys, 'echo.jwk')} is open to other users: chmod 600 it. Nothing changed.\n`)
    chmodSync(join(keys, 'echo.jwk'), 0o600)
    symlinkSync(join(keys, 'echo.jwk'), join(keys, 'link.jwk'))
    expect(ctl(dir, 'key', 'show', 'link').err).toBe(`Refused: ${join(keys, 'link.jwk')} is a symlink. Nothing changed.\n`)
    writeFileSync(join(keys, 'bad.jwk'), JSON.stringify({ ...A.privateJwk, kid: 'x' }), { mode: 0o600 })
    expect(ctl(dir, 'key', 'show', 'bad').err).toBe(`Refused: ${join(keys, 'bad.jwk')} does not hold one P-256 private JWK (kty, crv, x, y and d only). Nothing changed.\n`)
    chmodSync(keys, 0o750)
    const open = ctl(dir, 'key', 'create', 'next-one', '--apply')
    expect(open.err).toBe(`Refused: ${keys} is open to other users: chmod 700 it. Nothing changed.\n`)
    for (const r of [open, ctl(dir, 'key', 'show', 'echo')]) expect(r.out + r.err).not.toContain(secret)
  })
})
