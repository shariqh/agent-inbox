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

const GREETING = /^\s*(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^\n,!.?]{0,40}[,!]/i
const SIGN_OFF = /(?:^|[.!?…]\s+)(?:thanks|thank you|many thanks|best|best regards|kind regards|warm regards|regards|cheers|sincerely|all the best)\s*,\s*(.*)$/i
const SIGN_OFF_ALONE = /^\s*(?:(?:best|kind|warm) )?regards\s*$|^\s*sincerely\s*$/i
const SIGNER = /^(?:\p{Lu}[\p{L}.'-]*(?:\s+\p{Lu}[\p{L}.'-]*){0,2})?$/u
const HEADER = /^(from|to|cc|bcc|subject|date|sent|reply-to):[ \t]+\S/gim
const REPLY = [/\bOn\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:/, /^[>\s]*-{2,}\s*Original Message\s*-{2,}/im]
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const PHONE = [
  /(?<![\w+./-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w/-]|\.\d)/,
  /(?<![\w+])\+\d{1,3}(?:[\s.-]\d{2,4}){2,5}(?![\w])/,
]
const SECRET = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/,
  /\bsk-(?:ant-|proj-)?[\w-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[\w-]{35}/,
  /\b[rs]k_live_[0-9A-Za-z]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/,
  /(?<![A-Za-z0-9])(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[\w\-./+=]{8,}/i,
  /\bBearer\s+[\w\-.=]{20,}/i,
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function letterShape(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim())
  if (lines.slice(0, 3).some((line) => GREETING.test(line))) return true
  if (/^-- ?$/m.test(text)) return true
  return lines.slice(-6).some((line) => {
    if (SIGN_OFF_ALONE.test(line)) return true
    const rest = SIGN_OFF.exec(line)?.[1]
    return rest !== undefined && SIGNER.test(rest.trim())
  })
}

function allowed(address: string, allow: string[]): boolean {
  const a = address.toLowerCase()
  return allow.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('@') ? a.endsWith(e) || a.endsWith(`.${e.slice(1)}`) : a === e
  })
}

export function screen(text: string, options: ScreenOptions = {}): ScreenResult {
  const allow = [...DEFAULT_ALLOW, ...(options.allowEmails ?? [])]
  const lower = text.toLowerCase()
  const checks: Array<[ScreenClass, () => boolean]> = [
    ['letter-shape', () => letterShape(text)],
    ['email-headers', () => new Set([...text.matchAll(HEADER)].map((m) => m[1]!.toLowerCase())).size >= 2],
    ['reply-marker', () => REPLY.some((re) => re.test(text))],
    ['email-address', () => [...text.matchAll(EMAIL)].some((m) => !allowed(m[0], allow))],
    ['phone-number', () => PHONE.some((re) => re.test(text))],
    ['secret', () => SECRET.some((re) => re.test(text))],
    ['customer-path', () => (options.customerPaths ?? DEFAULT_CUSTOMER_PATHS).some((path) => {
      const tail = path.replace(/\/+$/, '').split('/').slice(-2).join('/')
      return tail.length > 1 && lower.includes(`${tail.toLowerCase()}/`)
    })],
    ['deny-list', () => (options.deny ?? '').split('\n').map((line) => line.trim())
      .filter((entry) => entry.length > 1 && !entry.startsWith('#'))
      .some((entry) => new RegExp(`(?<!\\w)${escape(entry)}(?!\\w)`, 'iu').test(text))],
  ]
  const classes = checks.filter(([, found]) => found()).map(([cls]) => cls)
  return classes.length ? { ok: false, classes } : { ok: true }
}
