// The query's shape and the screen's inputs (web search design §4.2, §7.1, §7.4): one line
// of 2-400 characters and at most 40 words after NFKC and collapsing whitespace, no
// control characters; sites are lower-case DNS names with a public suffix. The screen
// reads both deny lists, web search's own and unslop's, each time it runs, and takes the
// tailnet's own name from the `.ts.net` names `enable` seeded.
import { join } from 'node:path'
import { readPrivate } from '../files.js'
import type { QueryScreenOptions } from '../screen.js'

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const SITE = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`)
const NOT_PUBLIC = /\.(?:local|internal|localhost|lan|home|home\.arpa|corp|intranet|private|ts\.net)$/

/** The normalised query, or undefined when its shape is refused. */
export function shapeQuery(raw: string): string | undefined {
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(raw.trim())) return undefined
  const query = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (query.length < 2 || query.length > 400 || query.split(' ').length > 40) return undefined
  return query
}

export const siteShape = (site: string): boolean => SITE.test(site) && !NOT_PUBLIC.test(site)

/** The screen's options as they stand now: both deny lists, read fresh, and the profile's allowlist and customer folders. */
export function screenOptions(meshDir: string, profile: { allowEmails?: string[]; customerPaths?: string[] } = {}): QueryScreenOptions {
  const root = join(meshDir, 'mesh')
  const deny = ['web-search-deny.txt', 'unslop-deny.txt'].map((f) => readPrivate(join(root, f), true) ?? '').join('\n')
  const tailnets = deny.split('\n').map((e) => e.trim().toLowerCase()).filter((e) => !e.startsWith('#') && /\.ts\.net$/.test(e))
    .map((e) => e.split('.').slice(-3).join('.')).filter((e) => e.split('.').length === 3)
  return { deny, tailnets: [...new Set(tailnets)], allowEmails: profile.allowEmails, customerPaths: profile.customerPaths }
}
