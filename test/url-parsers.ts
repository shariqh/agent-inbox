// Add step 2: whether a URL parser accepts a malformed punycode label (`https://xn--a.example/`)
// differs between platforms: this Mac's Node rejects it, a Linux Node 24 build accepts it. The
// command's addedPlace and the bridge's address rule both ask the global URL, so a test can run them
// under each kind of parser by swapping it for the call. Test-only; nothing here ships.
const Real = URL
const MALFORMED = /^https?:\/\/(?:[^/:]*\.)?xn--(?:a|zz)\.[^/]*/

type Parser = 'platform' | 'rejecting' | 'accepting'

/**
 * A URL that answers as `kind`: `rejecting` refuses every malformed punycode host this file names;
 * `accepting` takes anything this platform's parser refuses only for such a host or for a port past
 * 65535, with its host as written (so the rule's own port check is what refuses such a port);
 * anything else is the platform's own.
 */
function parserOf(kind: Exclude<Parser, 'platform'>) {
  return class Stub extends Real {
    constructor(value: string | URL, base?: string | URL) {
      const text = String(value)
      if (kind === 'rejecting' && MALFORMED.test(text)) throw new TypeError('Invalid URL')
      if (kind === 'accepting' && !Real.canParse(text, base)) {
        // the same address with a well-formed label and no port, then the host as it was written
        const plain = text.replace(/xn--(a|zz)\./, 'accepted-$1.').replace(/:(\d+)(?=\/|$)/, (port, digits: string) => (Number(digits) > 65535 ? '' : port))
        super(plain, base)
        Object.defineProperty(this, 'hostname', { value: /^https?:\/\/([^/:]+)/.exec(text)![1]! })
        return
      }
      super(value, base)
    }

    static override canParse(value: string | URL, base?: string | URL): boolean {
      try {
        new Stub(value, base)
        return true
      } catch {
        return false
      }
    }
  }
}

/** Runs `body` once under each parser: this platform's, one that rejects the malformed labels, one that accepts them. */
export async function underEachParser(body: (kind: Parser) => void | Promise<void>): Promise<void> {
  await body('platform')
  for (const kind of ['rejecting', 'accepting'] as const) {
    globalThis.URL = parserOf(kind)
    try {
      await body(kind)
    } finally {
      globalThis.URL = Real
    }
  }
}
