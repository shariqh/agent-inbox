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
//   2. SOURCE — the `setInterval` callback is exactly that one call. Extraction
//      MOVES the mutable line rather than removing it: a stamp added in the
//      callback would be invisible to (1). A source pin is this repo's idiom for
//      what runtime cannot see (test/hardening.test.ts, test/shell.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { livenessTick } from '../src/mcp.js'
import { openDb, upsertActivity, recordActivityCall, listActivity } from '../src/store.js'

const START = Date.parse('2026-07-25T09:00:00.000Z')
const CLAIM = 'Executing Track B — 18-task viewer redesign'

// comment lines stripped so prose about setInterval can never satisfy the pin
const code = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n')

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

  it('is the ENTIRE body of the 5-minute timer — nothing else runs on that schedule', () => {
    const timers = [...code.matchAll(/setInterval\(([\s\S]*?)\)\.unref\(\)/g)]
    expect(timers, 'src/mcp.ts should arm exactly one interval').toHaveLength(1)
    // one call, one argument list, no second statement, no `&&` smuggle
    expect(timers[0]![1]!.trim()).toMatch(/^\(\)\s*=>\s*livenessTick\(db,\s*\w+\),\s*5\s*\*\s*60000$/)
  })

  it('never throws, whatever the db does — presence must not take the server down', () => {
    db.close()
    expect(() => livenessTick(db, 's1')).not.toThrow()
  })
})
