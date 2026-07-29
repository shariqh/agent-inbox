// test/live-tick.test.ts
//
// THE ONE LINE #45 TURNS ON, PINNED.
//
// `src/store.ts` says of `touchActivity`: "this is what the 5-minute timer in
// src/mcp.ts calls, and it must never touch `last_call_at`, or the two stamps
// collapse back into one and a `doing` claim becomes immortal again." CLAUDE.md
// says the same: "the timer must never call it, and that one line is the whole
// distinction." Nothing tested it.
//
// It was untestable by construction: the wiring lived inline in an anonymous
// `setInterval` callback, which no test can reach. Adding
// `recordActivityCall(db, sessionId)` beside `touchActivity(db, sessionId)`
// there reinstates the ORIGINAL bug in full — a claim that never decays — and
// the entire suite stayed green. The store tests that look like cover mutate
// `touchActivity` in src/store.ts, a DIFFERENT line; no store test can reach a
// timer. The only accidental signal was that REPLACING the call makes
// `touchActivity` a dead export and trips test/dead-exports.test.ts, which is
// not behavioural coverage of anything.
//
// So the tick is now a named export, `livenessTick`, and the timer's body is one
// call to it. Both pins below are load-bearing, and neither is enough alone:
//   1. BEHAVIOURAL — fire the tick across a modelled 12 hours of silence and
//      assert it moves liveness and NOTHING else. Kills any mutation of the
//      tick's own body (stamping `last_call_at` in addition to, or instead of,
//      `touchActivity`), and also a tick that does nothing at all.
//   2. SOURCE — nothing else stamps a real call. Extraction MOVES the mutable
//      line rather than removing it: a stamp added in the callback would be
//      invisible to (1). A source pin is this repo's idiom for what runtime
//      cannot see (test/hardening.test.ts, test/shell.test.ts).
//
// THE SOURCE PIN WAS ITSELF WRONG UNTIL NOW, and it is worth saying how, because
// the shape of the mistake is the general one. It read
// `/setInterval\(([\s\S]*?)\)\.unref\(\)/g`, expected exactly one match, and
// required that match's body to be the `livenessTick` call verbatim. Its NAME
// said "nothing else runs on that schedule". Its ASSERTION saw only `.unref()`'d
// `setInterval`s written in one exact spelling. Measured, both of these restore
// #45's bug in full and passed all 1014 tests:
//   (a) `setInterval(() => recordActivityCall(db, sessionId), 5*60000)` — no
//       `.unref()`, so the regex never matched it at all;
//   (b) a recursive `setTimeout` re-arm calling `recordActivityCall` — not a
//       `setInterval`, so likewise invisible.
// And it failed on a behaviour-identical reformat to a braced arrow body, which
// is the other half of a bad pin: hostile to refactors it should not care about.
//
// Replaced by two AST pins over src/mcp.ts (comments and imports are not call
// expressions, so neither prose nor the import line can satisfy them, and neither
// can see whitespace):
//   · `recordActivityCall` is called EXACTLY ONCE, from inside `heartbeat()`.
//     This is the invariant that actually matters, and it catches every
//     scheduling shape — interval, timeout, recursive, anything — because an
//     evasion has to call it from somewhere. It kills (a) and (b) outright.
//   · no timer callback reaches `heartbeat` or `recordActivityCall` through this
//     file's own named functions. That is what the old regex was reaching for,
//     minus the spelling, and it additionally kills the indirection the old pin
//     only caught by luck: `setInterval(alsoTick, …)` where `alsoTick` calls
//     `heartbeat()` — one `recordActivityCall`, still in `heartbeat`, bug back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import ts from 'typescript'
import { livenessTick } from '../src/mcp.js'
import { openDb, upsertActivity, recordActivityCall, listActivity } from '../src/store.js'

const START = Date.parse('2026-07-25T09:00:00.000Z')
const CLAIM = 'Executing Track B — 18-task viewer redesign'

const SRC = new URL('../src/mcp.ts', import.meta.url)
const ast = ts.createSourceFile('mcp.ts', readFileSync(SRC, 'utf8'), ts.ScriptTarget.ESNext, true)

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node)
  ts.forEachChild(node, (c) => walk(c, visit))
}

/** every `name(...)` in `node`. A comment mentioning it is not a call; nor is the import. */
const callsTo = (node: ts.Node, name: string): ts.CallExpression[] => {
  const out: ts.CallExpression[] = []
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n)
  })
  return out
}

/** the name of the nearest enclosing function, or undefined if it is anonymous. */
const enclosingFunction = (node: ts.Node): string | undefined => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n)) return n.name?.text
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent
      return ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : undefined
    }
  }
  return undefined
}

/** every identifier mentioned anywhere under `node` — deliberately over-broad. */
const identifiersIn = (node: ts.Node): string[] => {
  const out: string[] = []
  walk(node, (n) => { if (ts.isIdentifier(n)) out.push(n.text) })
  return out
}

/** name → identifiers it mentions, for every named function-like binding in the file. */
const bodyOf = new Map<string, string[]>()
walk(ast, (n) => {
  if (ts.isFunctionDeclaration(n) && n.name && n.body) bodyOf.set(n.name.text, identifiersIn(n.body))
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
    bodyOf.set(n.name.text, identifiersIn(n.initializer))
  }
})

/** closure of `seed` over bodyOf — what a call site can reach without leaving this file. */
const reachableFrom = (seed: string[]): Set<string> => {
  const seen = new Set<string>()
  const queue = [...seed]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    for (const next of bodyOf.get(name) ?? []) queue.push(next)
  }
  return seen
}

describe('the liveness tick moves liveness and nothing else (#45)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), 'inbox-tick-')), 'inbox.db'))
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    try { db.close() } catch { /* a test may have closed it deliberately */ }
    vi.useRealTimers()
  })

  it('keeps a session listed through 12 hours of silence WITHOUT renewing its claim', () => {
    upsertActivity(db, { session: 's1', project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing: CLAIM, detail: 'task 7 of 18' })
    recordActivityCall(db, 's1') // the status({doing}) call that made the claim
    const madeAt = listActivity(db)[0]!.last_call_at
    expect(madeAt).toBe(new Date(START).toISOString())

    // exactly what the process does when the human walks away: the timer fires
    // every five minutes and the agent calls nothing at all
    for (let m = 5; m <= 12 * 60; m += 5) {
      vi.setSystemTime(START + m * 60_000)
      livenessTick(db, 's1')
    }

    const live = listActivity(db)
    expect(live).toHaveLength(1)                  // liveness DID move — a crashed process would be gone by now
    expect(live[0]!.last_call_at).toBe(madeAt)    // work did NOT: the whole distinction, in one assertion
    expect(live[0]!.doing).toBe('open')           // …so the 12-hour-old claim is no longer advertised
    expect(live[0]!.idle).toBe(true)
    expect(live[0]!.detail).toBe('')
  })

  it('recordActivityCall has exactly one call expression in src/mcp.ts, and it is inside heartbeat()', () => {
    const found = callsTo(ast, 'recordActivityCall')
    expect(found.map((c) => ast.getLineAndCharacterOfPosition(c.getStart(ast)).line + 1)).toHaveLength(1)
    expect(enclosingFunction(found[0]!)).toBe('heartbeat')
  })

  it('no timer callback in src/mcp.ts reaches heartbeat or recordActivityCall through this file’s own named functions', () => {
    const timers = [...callsTo(ast, 'setInterval'), ...callsTo(ast, 'setTimeout')]
    expect(timers.length, 'src/mcp.ts should still be arming timers').toBeGreaterThan(0)
    for (const timer of timers) {
      const line = ast.getLineAndCharacterOfPosition(timer.getStart(ast)).line + 1
      const reached = reachableFrom(identifiersIn(timer.arguments[0]!))
      expect([...reached].filter((n) => n === 'heartbeat' || n === 'recordActivityCall'),
        `the timer at src/mcp.ts:${line} must move liveness only`).toEqual([])
    }
  })

  it('never throws, whatever the db does — presence must not take the server down', () => {
    db.close()
    expect(() => livenessTick(db, 's1')).not.toThrow()
  })
})
