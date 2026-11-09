// Untrusted web text (web search design §4.3, §8.1). `suspect()` runs a short list of
// patterns on a result's raw title and snippet and on each kept passage: instruction
// overrides, role or chat-template markers, "system prompt", "do not tell the user",
// text imitating the prompt's delimiters, Markdown images, bidirectional overrides,
// CSS-hidden text, an urgent "run this command", a request to paste into the reply and
// a link to a private address. Each runs on the raw text and again on the text a reader
// or the model sees (invisible characters gone, line breaks as spaces), so a zero-width
// character or a line break inside a phrase hides nothing; bidirectional overrides and
// Unicode tag characters are flagged on the raw text. It is a signal, not a guarantee.
// `clean()` is what the data part may carry: no controls, bidirectional overrides,
// zero-width, tag or variation-selector characters, no Markdown images or link
// references, and a length cap in code points.
import { isIP } from 'node:net'

const PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i,
  /<\|\s*(?:im_start|im_end|im_sep|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\s*\|>|\[\/?INST\]|<<\/?SYS>>/i,
  /\bsystem prompt\b/i,
  /\b(?:do not|don't|never)\s+(?:tell|inform|show|mention (?:this |it )?to|reveal (?:this |it )?to)\s+the\s+user\b/i,
  /\b(?:SOURCE\s+\S{1,64}\s+\[\d+\]|QUESTION\s+\S{1,64}|CHECK\s+\S{1,64})\s+(?:BEGIN|END)\b/,
  /!\[[^\]\n]*\]\([^)\n]*\)/,
  /[\u202A-\u202E\u2066-\u2069]/,
  /[\u{E0000}-\u{E007F}]/u,
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]))/i,
  /\b(?:run|execute|paste)\s+(?:this|these|the following)\s+commands?\s+(?:now|immediately|right away)\b/i,
  /\b(?:paste|put|include|add)\b[^.\n]{0,40}\binto your (?:reply|answer|response)\b/i,
]
const URL_HOST = /\b(?:https?|wss?|ftp):\/\/(?:[^\s/?#@]*@)?(\[[^\]\s]*\]|[^\s/?#:<>"'()[\]]+)/gi
const PRIVATE_NAME = /^(?:localhost|.+\.(?:localhost|local|internal|lan|home\.arpa))\.?$/i

function privateHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase()
  if (PRIVATE_NAME.test(host)) return true
  if (isIP(host) === 6) return host === '::1' || host === '::' || /^f[cd]|^fe[89ab]|^::ffff:/.test(host)
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number) as [number, number]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

export function suspect(text: string): boolean {
  return [text, visible(text).replace(/\s+/g, ' ')].some((t) => PATTERNS.some((p) => p.test(t)) || [...t.matchAll(URL_HOST)].some((m) => privateHost(m[1]!)))
}

// C0 and C1 controls but tab and newline, the soft hyphen, bidirectional marks and
// overrides, the Mongolian vowel separator, zero-width characters, the line and paragraph
// separators, variation selectors, the byte order mark and Unicode tag characters
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Without the characters a reader cannot see, so a check sees what a reader would. */
export const visible = (text: string): string => text.replace(/\r\n?/g, '\n').replace(UNSAFE, '').replace(/\t/g, ' ')

/** Text the data part may carry: one line unless `lines`, at most `max` code points. */
export function clean(text: string, max: number, lines = false): string {
  const kept = visible(text).replace(/!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, '').replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*\S.*$/gm, '')
  const shaped = lines ? kept.replace(/[ ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : kept.replace(/\s+/g, ' ').trim()
  const points = [...shaped]
  return points.length > max ? points.slice(0, max).join('').trimEnd() : shaped
}
