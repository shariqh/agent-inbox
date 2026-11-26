// The page's own files (public/), for both listeners: src/viewer-network.ts (loopback) and
// src/viewer-remote.ts (the remote entry). A file answers with an ETag taken from its bytes and may
// be revalidated: a matching If-None-Match is a 304 with no body. The guards send `no-cache` on
// these answers (cacheControlFor), so a browser keeps the file but asks before each use, and a slow
// link downloads only what changed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'

// the content tag of each request a file answered, by the request: the guards ask after the routes ran
const FILE_TAGS = new WeakMap<Request, string>()

function contentTag(path: string): string | null {
  try {
    return `"${createHash('sha256').update(readFileSync(path)).digest('base64url')}"`
  } catch {
    return null
  }
}

// Weak comparison, as GET and HEAD allow: a compressed answer carries the tag as W/"…".
function tagMatches(requested: string | undefined, tag: string): boolean {
  return requested?.trim() === '*'
    || requested?.split(',').some((member) => member.trim().replace(/^W\//, '') === tag) === true
}

/** serveStatic over `root`, with a content ETag on every 200 and a 304 for a matching If-None-Match. */
export function staticFiles(root: string): MiddlewareHandler {
  const serve = serveStatic({
    root,
    onFound: (path, c) => {
      const tag = contentTag(path)
      if (tag !== null) FILE_TAGS.set(c.req.raw, tag)
    },
  })
  return async (c, next) => {
    const answer = await serve(c, next)
    const tag = FILE_TAGS.get(c.req.raw)
    // a range (206), a refused range (416) or no file at all goes out as serveStatic made it
    if (!(answer instanceof Response) || tag === undefined || answer.status !== 200) return answer
    if (tagMatches(c.req.header('If-None-Match'), tag)) {
      await answer.body?.cancel()
      return new Response(null, { status: 304, headers: { ETag: tag } })
    }
    answer.headers.set('ETag', tag)
    return answer
  }
}

/**
 * The Cache-Control both guards send. The unversioned ESM graph must never mix two releases: a
 * file's 200 or 304 says `no-cache` (stored, but checked with the server before each use), and
 * everything else, every `/api/` answer, refusal and error included, says `no-store`.
 */
export function cacheControlFor(request: Request, status: number): 'no-cache' | 'no-store' {
  return FILE_TAGS.has(request) && (status === 200 || status === 304) ? 'no-cache' : 'no-store'
}
