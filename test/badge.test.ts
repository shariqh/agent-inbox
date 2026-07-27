// test/badge.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { titleWithBadge, focusHashFor, parseFocusHash } from '../public/badge.js'

describe('titleWithBadge', () => {
  it('prefixes the count when the attention set is non-empty', () => {
    expect(titleWithBadge('Agent Inbox', 3)).toBe('(3) Agent Inbox')
  })
  it('is the bare title at zero — the badge must be able to reach zero (tenet 2)', () => {
    expect(titleWithBadge('Agent Inbox', 0)).toBe('Agent Inbox')
  })
  it('never renders a negative or fractional count', () => {
    expect(titleWithBadge('Agent Inbox', -2)).toBe('Agent Inbox')
    expect(titleWithBadge('Agent Inbox', 2.7)).toBe('(2) Agent Inbox')
    expect(titleWithBadge('Agent Inbox', Number.NaN)).toBe('Agent Inbox')
  })
})

describe('focus hash', () => {
  it('round-trips an id', () => {
    expect(parseFocusHash(focusHashFor('abc-123'))).toEqual({ id: 'abc-123' })
  })
  it('encodes ids containing slashes so the hash stays parseable', () => {
    expect(focusHashFor('a/b')).toBe('#item/a%2Fb')
    expect(parseFocusHash('#item/a%2Fb')).toEqual({ id: 'a/b' })
  })
  it('parses a hash with no leading #', () => {
    expect(parseFocusHash('item/xyz')).toEqual({ id: 'xyz' })
  })
  it('ignores unrelated or empty hashes', () => {
    expect(parseFocusHash('#boards')).toBeNull()
    expect(parseFocusHash('#item/')).toBeNull()
    expect(parseFocusHash('')).toBeNull()
  })
})

// The Electron dock badge dynamically imports public/attention.js and
// public/badge.js from REPO_ROOT = path.resolve(__dirname, '..'), which inside
// the packaged .app is the STAGED root (Contents/Resources/app). If the
// packaging script ever stops copying public/ there, or starts using an asar
// archive, those imports fail and the dock badge silently freezes. Pin both.
describe('packaged app can resolve public/ from REPO_ROOT', () => {
  const sh = readFileSync(new URL('../scripts/package-app.sh', import.meta.url), 'utf8')
  it('stages public/ alongside electron/ and dist/', () => {
    expect(sh).toContain('cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/electron" "$STAGE/"')
  })
  it('packages unarchived, so plain file paths resolve at runtime', () => {
    expect(sh).toContain('--no-asar')
  })
})

// Pin: the Electron dock badge must derive its count from the SAME §7
// predicate the viewer uses (public/attention.js's attentionCount), not a
// hand-rolled inline filter. A duplicate predicate is exactly the bug this
// task exists to fix — it can disagree with the viewer, and (worse) it can
// never reach zero for an already-annotated blocked row.
describe('the Electron dock badge shares the §7 attention predicate (no duplicate)', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')

  it('does not re-implement the needs-you filter inline', () => {
    expect(main).not.toContain('.filter((i) => !i.reply)')
  })
  it('does not re-implement the blocked-row filter inline', () => {
    expect(main).not.toContain("r.status === 'blocked'")
  })
  // issue #37 changed what a blocked row MEANS — twice. The requirement on
  // main.cjs is NEGATIVE: it must gain nothing, because its count is
  // attentionEntries(...).length against the shared module and therefore follows
  // for free. A local mention of the row vocabulary would be a second predicate
  // by another name.
  //
  // The first draft of this guard asked only for the exact word "annotation" —
  // and passed while the file's own comment claimed "annotated-and-seen blocked
  // rows are OUT", which #37 had already made false. A comment cannot be
  // executed, so a rule written in one goes stale in silence; that is the whole
  // failure mode. So the guard covers the FAMILY, prose included: main.cjs may
  // call the predicate, count it and render it, but may not say what it decides.
  const ROW_RULE_VOCABULARY = [/annotat/i, /pickup/i, /picked[- ]up/i, /delivered/i, /\bblocked\b/i, /\bstale\b/i, /unanswered/i]
  it('never restates the attention rule — not in code, not in a comment', () => {
    for (const re of ROW_RULE_VOCABULARY) {
      expect(main, `electron/main.cjs must not describe what counts as attention (${re}) — public/attention.js owns that, and a copy in a comment goes stale silently`).not.toMatch(re)
    }
  })
  it('dynamically imports the shared attention module rather than re-deriving it', () => {
    expect(main).toContain("path.join(REPO_ROOT, 'public', 'attention.js')")
    expect(main).toMatch(/import\(pathToFileURL\(ATTENTION_PATH\)/)
  })
  it('sizes the dock badge off the shared attention set, not a local list length', () => {
    expect(main).toMatch(/attentionEntries\(/)
    expect(main).toMatch(/setBadgeCount\(attn\.length\)/)
  })
  // issue #32: the dock badge and the title badge must agree on the CLOSED set
  // too, or tenet 3 breaks in the most visible place there is — the dock. The
  // main process cannot read the renderer's localStorage, which is exactly why
  // closure is server state; this pins that main.cjs actually reads it.
  it('reads the same closed set the title badge reads, and passes it to the shared predicate', () => {
    expect(main).toContain('api/projects/closed')
    expect(main).toMatch(/attentionEntries\([^\n]*closed\s*\)/)
  })

  it('fails OPEN on the closed-set fetch — an unknown closed set suppresses nothing', () => {
    // confirmReuse() can attach this app to an OLDER standalone viewer with no
    // such route. Failing open over-counts (a truthful superset); failing closed
    // would dark the badge entirely, which tenet 2 cannot survive.
    const line = main.split('\n').find((l) => l.includes('api/projects/closed'))
    expect(line, 'no api/projects/closed fetch found').toBeTruthy()
    const block = main.slice(main.indexOf('api/projects/closed'))
    expect(block.slice(0, 200)).toMatch(/\.catch\(/)
    expect(block.slice(0, 200)).toMatch(/res\.ok|r\.ok/)
  })

  // Reopen is the feature's advertised happy path, so this fires routinely:
  // if `known` were rebuilt from the SUPPRESSED set, closing a project would
  // drop its items from `known`, and reopening would re-classify every one of
  // them as "fresh" — a native OS notification for items the human closed days
  // ago. `known` therefore tracks what EXISTS; the badge and the notification
  // body read what is VISIBLE.
  it('maintains its seen-set from the UNSUPPRESSED set, so reopening announces nothing old', () => {
    const watch = main.slice(main.indexOf('function startAttentionWatch'))
    expect(watch).toMatch(/known\s*=\s*new Set\(everything\.map/)
    expect(watch).toMatch(/const everything = attentionEntries\(items, boards, Date\.now\(\), liveSessions\)/)
  })

  it('never swallows a failed module import silently', () => {
    // a bare `.catch(() => {})` (or no .catch at all) would freeze the badge
    // forever with no signal — the import failure path must log loudly
    expect(main).toMatch(/console\.error\([^)]*attention/i)
  })
})

// Fix round 1: focusItem() used to open only the target [data-card-id]
// element, so a deep link into a collapsed stale-fold or archived-fold
// switched tabs and updated the URL hash but left the target hidden inside a
// closed <details> — scrollIntoView()/.focus() silently no-op on a
// display:none element. Pinned as SOURCE TEXT against the isolated focusItem()
// function body, so a match elsewhere in the file (e.g. a different
// `parentElement` walk) can't false-positive this. The runtime half of
// focusItem — that a deep link never freezes the poll — is exercised for real
// in test/dom/focus-item.test.ts.
describe('focusItem opens ancestor <details> folds, not just the target (fix round 1)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function focusItem(')
  const end = js.indexOf('\nlet bootFocusDone', start)
  if (start === -1 || end === -1) throw new Error('focusItem() not found at its expected shape in public/app.js')
  const body = js.slice(start, end)

  it('walks the ancestor chain rather than opening only the target element', () => {
    expect(body).toMatch(/parentElement/)
    // this is exactly the regression the fix replaced — pin it gone
    expect(body).not.toMatch(/if \(el\.tagName === 'DETAILS'\) el\.open = true/)
  })
  it('flips staleFoldOpen so the next 3s poll does not re-collapse the stale fold', () => {
    expect(body).toMatch(/staleFoldOpen\s*=\s*true/)
  })
  it('flips showArchived so the next 3s poll does not re-collapse the archived fold', () => {
    expect(body).toMatch(/showArchived\s*=\s*true/)
  })
})
