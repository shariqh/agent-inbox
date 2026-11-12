// A public `https://` agent's DNS answers (#534; mesh design §8.8). `meshctl add`, `call` and
// `check` connect to a public name only through `publicLookup()`: every address the name resolves
// to must be a public unicast address, or the lookup fails with NOT_PUBLIC and no connection is
// opened. The socket connects to an address this lookup returned, so a second DNS answer cannot
// swap in a private address between the check and the connect (DNS rebinding); a later connection
// on a keep-alive pool looks up, and checks, again. Node core only; meshctl's clients import it,
// never the stdio MCP server or the viewer.
import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'

/** The error code a refused answer carries; fetchCard reports it as `private`. */
export const NOT_PUBLIC = 'ERR_MESH_NOT_PUBLIC'

// IPv4 that is not public unicast: this network, private, shared (Tailscale's and carrier NAT's
// 100.64.0.0/10), loopback, link-local, IETF assignments, documentation, 6to4 relay, benchmarking,
// multicast and reserved (with the broadcast address)
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
// IPv6 public unicast is 2000::/3 less these: Teredo, benchmarking, ORCHID, documentation, 6to4
// (which can carry a private IPv4) and the second documentation prefix
const V6_SPECIAL: Array<[string, number]> = [
  ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]
const v4Blocked = new BlockList()
for (const [net, prefix] of V4) v4Blocked.addSubnet(net, prefix, 'ipv4')
const v6Global = new BlockList()
v6Global.addSubnet('2000::', 3, 'ipv6')
const v6Special = new BlockList()
for (const [net, prefix] of V6_SPECIAL) v6Special.addSubnet(net, prefix, 'ipv6')

/** An IPv6 address as its eight 16-bit groups, a trailing dotted IPv4 included; undefined when malformed. */
function groups(address: string): number[] | undefined {
  let s = address.toLowerCase()
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const part = (h: string | undefined): string[] => (h ? h.split(':') : [])
  const head = part(halves[0])
  const tail = part(halves[1])
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail]
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined
  return all.map((g) => parseInt(g, 16))
}

/**
 * The IPv4 address an IPv6 address carries when it is IPv4-mapped (`::ffff:0:0/96`) or the
 * well-known NAT64 prefix (`64:ff9b::/96`, which an IPv6-only network uses to reach IPv4 hosts).
 */
function embeddedV4(address: string): string | undefined {
  const g = groups(address)
  if (!g) return undefined
  const prefix = g.slice(0, 6).join(',')
  if (prefix !== '0,0,0,0,0,65535' && prefix !== '100,65435,0,0,0,0') return undefined
  return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.')
}

/** Whether `address` is a public unicast IP address; anything that is not an IP address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !v4Blocked.check(address, 'ipv4')
  if (family !== 6 || address.includes('%')) return false
  const v4 = embeddedV4(address)
  if (v4 !== undefined) return isPublicAddress(v4)
  return v6Global.check(address, 'ipv6') && !v6Special.check(address, 'ipv6')
}

/**
 * A lookup for `net.connect` that resolves every address of the name (`resolve`, the system's by
 * default; `isPublic` is a test seam only) and fails with NOT_PUBLIC unless each is public, before
 * any connection; otherwise it answers what `net.connect` asked for, one address or all of them.
 */
export function publicLookup(resolve: LookupFunction = dnsLookup as LookupFunction, isPublic: (address: string) => boolean = isPublicAddress): LookupFunction {
  return ((hostname: string, options: LookupOptions, done: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    const wantsAll = options.all === true
    resolve(hostname, { ...options, all: true }, (error, answer) => {
      if (error) return wantsAll ? done(error, []) : done(error, '', 0)
      const addresses = (Array.isArray(answer) ? answer : [{ address: answer, family: isIP(answer) }]) as LookupAddress[]
      if (!addresses.length || addresses.some((a) => !isPublic(a.address))) {
        const refused: NodeJS.ErrnoException = Object.assign(new Error('the name resolves to an address that is not public'), { code: NOT_PUBLIC })
        return wantsAll ? done(refused, []) : done(refused, '', 0)
      }
      if (wantsAll) return done(null, addresses)
      done(null, addresses[0]!.address, addresses[0]!.family)
    })
  }) as LookupFunction
}
