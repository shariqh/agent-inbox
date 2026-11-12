// The address check for a public `https://` agent (#534; mesh design §8.8): which addresses count
// as public, and publicLookup's answers, never a real DNS query.
import type { LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { describe, expect, it } from 'vitest'
import { NOT_PUBLIC, isPublicAddress, publicLookup } from '../src/public-address.js'

describe('isPublicAddress', () => {
  it('refuses every IPv4 range that is not public unicast', () => {
    for (const address of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.101.102.103', '100.127.255.254', '127.0.0.1', '127.8.9.10',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
      '198.51.100.7', '203.0.113.7', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('takes public IPv4, just outside each refused range', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
      '169.253.255.255', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('refuses IPv6 outside global unicast and its special prefixes, and judges an embedded IPv4 by its own rule', () => {
    for (const address of ['::', '::1', 'fe80::1', 'fec0::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '100::1', '2001:db8::1', '2001::1',
      '2001:2::1', '2001:10::1', '2001:20::1', '2002:a00:1::1', '3fff::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1',
      '::ffff:100.100.1.2', '64:ff9b::a00:1', '64:ff9b::192.168.0.1', '64:ff9b:1::1', '::10.0.0.1', '::8.8.8.8', 'fe80::1%en0', '2606:4700::1111%en0']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1', '3ffe::1', '::ffff:8.8.8.8', '::FFFF:1.1.1.1', '64:ff9b::808:808', '64:ff9b::1.1.1.1']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('is false for anything that is not an IP address', () => {
    for (const value of ['', 'agent.example.org', 'localhost', '1.1.1', '1.1.1.1.1', '::g', '1::2::3', '256.1.1.1']) expect(isPublicAddress(value), value).toBe(false)
  })
})

type Done = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
/** A resolver that answers `addresses` and records each question; never the network. */
function resolver(addresses: string[] | NodeJS.ErrnoException) {
  const asked: Array<{ host: string; all: unknown }> = []
  const lookup = ((host: string, options: { all?: boolean }, done: Done) => {
    asked.push({ host, all: options.all })
    if (!Array.isArray(addresses)) return done(addresses, [])
    done(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
  }) as unknown as LookupFunction
  return { lookup, asked }
}
const ask = (lookup: LookupFunction, all: boolean): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> =>
  new Promise((done) => lookup('agent.example.org', { all }, (error, address, family) => done({ error, address, family })))

describe('publicLookup', () => {
  it('answers what net.connect asks for, one address or all, after asking the resolver for every address', async () => {
    const r = resolver(['1.1.1.1', '2606:4700:4700::1111'])
    const guarded = publicLookup(r.lookup)
    expect(await ask(guarded, false)).toEqual({ error: null, address: '1.1.1.1', family: 4 })
    expect(await ask(guarded, true)).toEqual({ error: null, address: [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }], family: undefined })
    expect(r.asked).toEqual([{ host: 'agent.example.org', all: true }, { host: 'agent.example.org', all: true }])
  })

  it('fails with NOT_PUBLIC when any address is not public, or none came back', async () => {
    for (const answer of [['127.0.0.1'], ['1.1.1.1', '10.0.0.7'], ['::1'], ['100.101.102.103'], []]) {
      const guarded = publicLookup(resolver(answer).lookup)
      for (const all of [false, true]) {
        const got = await ask(guarded, all)
        expect([got.error?.code, got.address], `${answer.join(',')} all=${all}`).toEqual([NOT_PUBLIC, all ? [] : ''])
      }
    }
  })

  it('checks every lookup on its own, so a second answer cannot swap in a private address', async () => {
    let n = 0
    const flipping = ((_host: string, _o: unknown, done: Done) => done(null, [{ address: n++ ? '192.168.1.10' : '8.8.8.8', family: 4 }])) as unknown as LookupFunction
    const guarded = publicLookup(flipping)
    expect((await ask(guarded, false)).address).toBe('8.8.8.8')
    expect((await ask(guarded, false)).error?.code).toBe(NOT_PUBLIC)
  })

  it('passes a resolver error through, and takes a test seam for what counts as public', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
    expect((await ask(publicLookup(resolver(missing).lookup), false)).error?.code).toBe('ENOTFOUND')
    expect((await ask(publicLookup(resolver(['127.0.0.1']).lookup, (a) => a === '127.0.0.1'), false)).address).toBe('127.0.0.1')
  })
})
