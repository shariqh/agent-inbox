// The privacy screen (#483, unslop design §5): deterministic, on the Mac, before
// any network. It refuses on any one class and names the class only, never the
// matched value. There is no override. `--kind` is required but self-declared:
// it forces a classification and enforces nothing.
import { BlockList, isIP } from 'node:net'
import { networkInterfaces, userInfo } from 'node:os'

export const KINDS = ['pr', 'issue', 'release-notes', 'docs', 'blog'] as const
export type Kind = (typeof KINDS)[number]
export const parseKind = (value: unknown): Kind | undefined =>
  (KINDS as readonly unknown[]).includes(value) ? (value as Kind) : undefined

export type ScreenClass =
  | 'letter-shape' | 'email-headers' | 'reply-marker' | 'email-address'
  | 'phone-number' | 'secret' | 'customer-path' | 'deny-list'
export type ScreenOptions = {
  /** unslop-deny.txt's text: one customer name or domain per line, `#` comments */
  deny?: string
  /** addresses, or `@domain` for a domain and its subdomains */
  allowEmails?: string[]
  /** customer notes folders; a path through the last two segments of one is refused */
  customerPaths?: string[]
}
export type ScreenResult = { ok: true } | { ok: false; classes: ScreenClass[] }

const DEFAULT_ALLOW = ['@users.noreply.github.com', '@example.com', '@example.org', '@example.net']
const DEFAULT_CUSTOMER_PATHS = ['~/dev/obsidian-notes/customers/']

// "Hi Jane," "Hi team —" "Dear Sam"; never "Hi-DPI" or "Hello world"
const GREETING = /^\s*(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))(?=[\s,!]|$)(?!\s+world\b)[^\n,!.?—–]{0,40}(?:[,!—–]|\s-(?:\s|$))/i
const GREETING_NAME = /^\s*(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s+(?!World\b)\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*){0,2}\s*$/u
const SIGN_OFF = /(?:^|[.!?…]\s+)(?:thanks(?: so much| again)?|thank you(?: so much)?|many thanks|(?:best|kind|warm) regards|regards|best|cheers|sincerely|all the best|take care|talk soon)\s*([,!.—–]|\s-(?=\s|$))?\s*(.*)$/i
const SIGN_OFF_ALONE = /^\s*(?:(?:best|kind|warm) )?regards\s*$|^\s*sincerely\s*$/i
const NAME = /^\p{Lu}[\p{L}.'-]*(?:\s+\p{Lu}[\p{L}.'-]*){0,3}$/u
// capitalised lines that are headings, not a signer's name
const NOT_NAME = /\b(?:issues?|notes?|links?|changes?|changelog|practices?|steps?|summary|testing|tests?|related|expected|actual|references?|docs?|documentation|examples?|usage|install(?:ation)?|setup|overview|details|background|context|features?|fix(?:es)?|bugs?|release|versions?|faq|license|credits?|contents?|appendix)\b/i
const HEADER = /^(from|to|cc|bcc|subject|date|sent|reply-to):[ \t]+\S/gim
const HEADER_LINE = /^(?:from|to|cc|bcc|subject|date|sent|reply-to):[ \t]+\S/i
const REPLY = [/\bOn\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:/, /^[>\s]*-{2,}\s*Original Message\s*-{2,}/im]
// the last label is letters, so `pkg@1.2.3` and `action@v7.1.0` are not addresses
const EMAIL = /(?<![\w.+/-])[\w.+-]+@([\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,})(?![\w-])/g
const PHONE = [
  /(?<![\w+./-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w/-]|\.\d)/,
  /(?<![\w+])\+\d{1,3}(?:[\s.-]\d{2,4}){2,5}(?![\w])/,
]
// national numbers with a trunk 0 and 10-11 digits: 020 7946 0958, (020) 7946 0958
const NATIONAL = /(?<![\w+./:-])(?:0[1-9]\d{1,3}|\(0[1-9]\d{0,3}\))[\s.-]?\d{3,4}[\s.-]\d{4}(?![\w/:-]|\.\d)/g
// a placeholder, not a secret: <your-password>, ${X}, {{ x }}, process.env.X, os.environ[...], ****
const PLACEHOLDER = String.raw`(?![<$\{*]|process\.env|os\.environ)`
const SECRET = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/,
  /\bsk-(?:ant-|proj-)?[\w-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[\w-]{35}/,
  /\b[rs]k_live_[0-9A-Za-z]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /\bglpat-[\w-]{20,}/,
  /hooks\.slack\.com\/services\/T\w+\/B\w+\/\w+/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/,
  new RegExp(String.raw`(?<![A-Za-z0-9])(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?${PLACEHOLDER}(?=[^\s"']*\d)[\w\-./+=]{8,}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z0-9])(?:password|passwd|passphrase)["']?\s*[:=]\s*["']?${PLACEHOLDER}(?=[^\s"']*[^a-z\s"'])[^\s"']{8,}`, 'i'),
  /\bBearer\s+[\w\-.=]{20,}/i,
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Line = { text: string; quoted: boolean }

function signsOff(lines: Line[], i: number): boolean {
  const m = SIGN_OFF.exec(lines[i]!.text)
  if (!m) return SIGN_OFF_ALONE.test(lines[i]!.text)
  const rest = m[2]!.trim()
  // "Cheers — Shariq" and "Best, Shariq" on one line need the mark between them
  if (rest) return Boolean(m[1]) && m[1] !== '.' && NAME.test(rest)
  if (m[1] === ',') return true
  // "Thanks!" or "Thanks" alone signs off only above a person's name
  const next = lines[i + 1]?.text.trim() ?? ''
  return NAME.test(next) && !NOT_NAME.test(next)
}

function letterShape(lines: Line[]): boolean {
  if (lines.some((l) => /^-- ?$/.test(l.text))) return true
  // a quoted greeting counts only when the quote also signs off or has headers
  const quotedLetter = lines.some((l, i) => l.quoted && (HEADER_LINE.test(l.text) || signsOff(lines, i)))
  const greets = (l: Line, i: number): boolean => (l.quoted ? quotedLetter : i < 3) && (GREETING.test(l.text) || GREETING_NAME.test(l.text))
  return lines.some((l, i) => greets(l, i) || ((l.quoted || i >= lines.length - 12) && signsOff(lines, i)))
}

function allowed(address: string, allow: string[]): boolean {
  const a = address.toLowerCase()
  return allow.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('@') ? a.endsWith(e) || a.endsWith(`.${e.slice(1)}`) : a === e
  })
}

/** `only` runs a subset of the classes: web search's query screen runs five of them (§7.1). */
export function screen(input: string, options: ScreenOptions = {}, only?: readonly ScreenClass[]): ScreenResult {
  const allow = [...DEFAULT_ALLOW, ...(options.allowEmails ?? [])]
  const raw = input.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  // quoted reply lines are screened as if unquoted
  const lines = raw.split('\n').filter((l) => l.trim())
    .map((l) => ({ text: l.replace(/^[ \t]*(?:>[ \t]?)+/, ''), quoted: /^[ \t]*>/.test(l) }))
  const text = lines.map((l) => l.text).join('\n')
  const lower = text.toLowerCase()
  const checks: Array<[ScreenClass, () => boolean]> = [
    ['letter-shape', () => letterShape(lines)],
    ['email-headers', () => new Set([...text.matchAll(HEADER)].map((m) => m[1]!.toLowerCase())).size >= 2],
    ['reply-marker', () => REPLY.some((re) => re.test(text))],
    ['email-address', () => [...text.matchAll(EMAIL)].some((m) => !allowed(m[0], allow)
      && !/(?:^|\.)\d+(?:\.|$)/.test(m[1]!)
      && !(m[0].startsWith('git@') && text[m.index! + m[0].length] === ':'))],
    ['phone-number', () => PHONE.some((re) => re.test(text))
      || [...text.matchAll(NATIONAL)].some((m) => /^\d{10,11}$/.test(m[0].replace(/\D/g, '')))],
    ['secret', () => SECRET.some((re) => re.test(text))],
    ['customer-path', () => (options.customerPaths ?? DEFAULT_CUSTOMER_PATHS).some((path) => {
      const tail = path.replace(/\/+$/, '').split('/').slice(-2).join('/')
      return tail.length > 1 && lower.includes(`${tail.toLowerCase()}/`)
    })],
    ['deny-list', () => (options.deny ?? '').normalize('NFKC').split('\n').map((line) => line.trim())
      .filter((entry) => entry.length > 1 && !entry.startsWith('#'))
      .some((entry) => new RegExp(`(?<!\\w)${escape(entry)}(?!\\w)`, 'iu').test(text))],
  ]
  const classes = checks.filter(([cls, found]) => (!only || only.includes(cls)) && found()).map(([cls]) => cls)
  return classes.length ? { ok: false, classes } : { ok: true }
}

// Web search's query screen (web search design §7.1): five of the classes above, whose
// shapes make sense on one line, and two query classes for what is this Mac's own.
export type QueryClass = 'email-address' | 'phone-number' | 'secret' | 'customer-path' | 'deny-list' | 'private-name' | 'home-path'
export type QueryScreenOptions = ScreenOptions & {
  /** this Mac's interface subnets as CIDRs; os.networkInterfaces()'s by default */
  interfaces?: string[]
  /** the tailnet's own names, `<tailnet>.ts.net` */
  tailnets?: string[]
  /** this Mac's user name; os.userInfo()'s by default */
  user?: string
}
const FIVE: ScreenClass[] = ['email-address', 'phone-number', 'secret', 'customer-path', 'deny-list']
// loopback and the router addresses documentation questions name all the time
const KNOWN_ADDRESSES = new Set(['127.0.0.1', '::1', '192.168.0.1', '192.168.1.1', '192.168.1.254', '10.0.0.1', '10.0.0.138'])
const GENERIC_LABELS = new Set(['localhost', 'host', 'server', 'printer', 'router', 'example', 'foo', 'bar', 'my-host', 'myhost', 'machine', 'device', 'node', 'name', 'your-host', 'hostname'])
const LABEL = String.raw`[\w*<>{}-]+`
const PRIVATE_HOST = new RegExp(String.raw`(?<![\w.*<>{}-])(${LABEL})(?:\.${LABEL})*\.(?:local|internal|ts\.net)(?![\w-]|\.\w)`, 'gi')
const generic = (label: string): boolean => GENERIC_LABELS.has(label.toLowerCase()) || /^(?:\*|<.*>|\{.*\})$/.test(label)

function localSubnets(cidrs: string[] | undefined): BlockList {
  const list = new BlockList()
  const all = cidrs ?? Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.cidr ?? '')
  for (const cidr of all) {
    const [address = '', prefix] = cidr.split('/')
    const family = isIP(address)
    if (family && prefix !== undefined) list.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

function privateName(text: string, o: QueryScreenOptions): boolean {
  const subnets = localSubnets(o.interfaces)
  const addresses = text.split(/[\s,;()<>"'`\[\]]+/).map((t) => t.replace(/[.,?!:]+$/, '').replace(/^(?:[a-z]+:\/\/)?/i, '').replace(/[%/].*$/, ''))
  const candidates = addresses.flatMap((t) => (isIP(t) ? [t] : isIP(t.replace(/:\d+$/, '')) === 4 ? [t.replace(/:\d+$/, '')] : []))
  if (candidates.some((a) => !KNOWN_ADDRESSES.has(a) && subnets.check(a, isIP(a) === 4 ? 'ipv4' : 'ipv6'))) return true
  if ([...text.matchAll(PRIVATE_HOST)].some((m) => !generic(m[1]!))) return true
  return (o.tailnets ?? []).map((t) => t.toLowerCase().replace(/\.ts\.net\.?$/, '')).filter((t) => t.length > 1)
    .some((name) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, 'i').test(text))
}

function homePath(text: string, o: QueryScreenOptions): boolean {
  const user = o.user ?? userInfo().username
  return Boolean(user) && new RegExp(`(?<![\\w.~-])/(?:Users|home)/${escape(user)}(?![\\w.-])`, 'i').test(text)
}

/** Refuses, never redacts: the classes a one-line query trips, before any network. `deny` holds both deny lists. */
export function screenQuery(query: string, options: QueryScreenOptions = {}): { ok: true } | { ok: false; classes: QueryClass[] } {
  const text = query.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  const five = screen(text, options, FIVE)
  const classes: QueryClass[] = five.ok ? [] : (five.classes as QueryClass[])
  if (privateName(text, options)) classes.push('private-name')
  if (homePath(text, options)) classes.push('home-path')
  return classes.length ? { ok: false, classes } : { ok: true }
}
