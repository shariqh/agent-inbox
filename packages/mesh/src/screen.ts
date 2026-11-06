// The privacy screen (#483, unslop design §5): deterministic, on the Mac, before
// any network. It refuses on any one class and names the class only, never the
// matched value. There is no override. `--kind` is required but self-declared:
// it forces a classification and enforces nothing.
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

const GREETING = /^\s*(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^\n,!.?—–:]{0,40}(?:[,!—–:]|\s-(?:\s|$))/i
const GREETING_NAME = /^\s*(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s+\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*){0,2}\s*$/u
const SIGN_OFF = /(?:^|[.!?…]\s+)(?:thanks(?: so much| again)?|thank you(?: so much)?|many thanks|(?:best|kind|warm) regards|regards|best|cheers|sincerely|all the best|take care|talk soon)\s*([,!.—–]|\s-(?=\s|$))?\s*(.*)$/i
const SIGN_OFF_ALONE = /^\s*(?:(?:best|kind|warm) )?regards\s*$|^\s*sincerely\s*$/i
const NAME = /^\p{Lu}[\p{L}.'-]*(?:\s+\p{Lu}[\p{L}.'-]*){0,3}$/u
const HEADER = /^(from|to|cc|bcc|subject|date|sent|reply-to):[ \t]+\S/gim
const REPLY = [/\bOn\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:/, /^[>\s]*-{2,}\s*Original Message\s*-{2,}/im]
// the last label is letters, so `pkg@1.2.3` and `action@v7.1.0` are not addresses
const EMAIL = /(?<![\w.+/-])[\w.+-]+@([\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,})(?![\w-])/g
const PHONE = [
  /(?<![\w+./-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w/-]|\.\d)/,
  /(?<![\w+])\+\d{1,3}(?:[\s.-]\d{2,4}){2,5}(?![\w])/,
  // national numbers with a trunk 0: 020 7946 0958, (020) 7946 0958
  /(?<![\w+./:-])(?:0\d{2,4}|\(0\d{1,4}\))[\s.-]?\d{3,4}[\s.-]\d{3,4}(?![\w/:-]|\.\d)/,
]
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
  /(?<![A-Za-z0-9])(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[\w\-./+=]{8,}/i,
  /(?<![A-Za-z0-9])(?:password|passwd|passphrase)["']?\s*[:=]\s*["']?(?=[^\s"']*[^a-z\s"'])[^\s"']{8,}/i,
  /\bBearer\s+[\w\-.=]{20,}/i,
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Line = { text: string; quoted: boolean }

function letterShape(lines: Line[]): boolean {
  if (lines.some((l) => /^-- ?$/.test(l.text))) return true
  if (lines.some((l, i) => (i < 3 || l.quoted) && (GREETING.test(l.text) || GREETING_NAME.test(l.text)))) return true
  return lines.some((l, i) => {
    if (i < lines.length - 12 && !l.quoted) return false
    if (SIGN_OFF_ALONE.test(l.text)) return true
    const m = SIGN_OFF.exec(l.text)
    if (!m) return false
    const rest = m[2]!.trim()
    // "Thanks," signs off; "Thanks!" only with a name beside or below it
    if (rest) return NAME.test(rest)
    return m[1] === ',' || NAME.test(lines[i + 1]?.text.trim() ?? '')
  })
}

function allowed(address: string, allow: string[]): boolean {
  const a = address.toLowerCase()
  return allow.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('@') ? a.endsWith(e) || a.endsWith(`.${e.slice(1)}`) : a === e
  })
}

export function screen(input: string, options: ScreenOptions = {}): ScreenResult {
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
    ['phone-number', () => PHONE.some((re) => re.test(text))],
    ['secret', () => SECRET.some((re) => re.test(text))],
    ['customer-path', () => (options.customerPaths ?? DEFAULT_CUSTOMER_PATHS).some((path) => {
      const tail = path.replace(/\/+$/, '').split('/').slice(-2).join('/')
      return tail.length > 1 && lower.includes(`${tail.toLowerCase()}/`)
    })],
    ['deny-list', () => (options.deny ?? '').normalize('NFKC').split('\n').map((line) => line.trim())
      .filter((entry) => entry.length > 1 && !entry.startsWith('#'))
      .some((entry) => new RegExp(`(?<!\\w)${escape(entry)}(?!\\w)`, 'iu').test(text))],
  ]
  const classes = checks.filter(([, found]) => found()).map(([cls]) => cls)
  return classes.length ? { ok: false, classes } : { ok: true }
}
