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
  it('dynamically imports the shared attention module rather than re-deriving it', () => {
    expect(main).toContain("path.join(REPO_ROOT, 'public', 'attention.js')")
    expect(main).toMatch(/import\(pathToFileURL\(ATTENTION_PATH\)/)
  })
  it('sizes the dock badge off the shared attention set, not a local list length', () => {
    expect(main).toMatch(/attentionEntries\(/)
    expect(main).toMatch(/setBadgeCount\(attn\.length\)/)
  })
  it('never swallows a failed module import silently', () => {
    // a bare `.catch(() => {})` (or no .catch at all) would freeze the badge
    // forever with no signal — the import failure path must log loudly
    expect(main).toMatch(/console\.error\([^)]*attention/i)
  })
})
