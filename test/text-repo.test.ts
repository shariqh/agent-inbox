import { describe, expect, it } from 'vitest'
import { cardLinks } from '../public/link-strip.js'
import { textRepo } from '../public/source.js'
import { renderStructuredText } from '../public/structured-text.js'

// Issue #588: a plan row's bare #N is read against the row's own issue link,
// not only its plan's repository.
const A = 'owner/a'
const B = 'owner/b'
const ROOT = '/Users/s/Development/a'

const plan = { id: 'p1', repo: A, repo_root: ROOT }
const linkedRow = { id: 'r1', label: 'Land the fix', issue_repo: B, issue_number: 585 }
const render = (text: string, entity: object, identity: object) => renderStructuredText(text, textRepo(entity, identity))

describe('textRepo (issue #588)', () => {
  it('reads a row against its own issue link, then its plan’s pinned issue, then the plan’s repository', () => {
    expect(textRepo(linkedRow, { ...plan, issue_pin_repo: 'owner/pin', issue_pin_number: 7 }).repo).toBe(B)
    expect(textRepo({ id: 'r2', label: 'x' }, { ...plan, issue_pin_repo: 'owner/pin', issue_pin_number: 7 }).repo).toBe('owner/pin')
    expect(textRepo({ id: 'r2', label: 'x' }, plan).repo).toBe(A)
  })

  it('skips an invalid link or pin instead of trusting it', () => {
    const badRow = { id: 'r3', label: 'x', issue_repo: 'not a repo', issue_number: 585 }
    const noNumber = { id: 'r4', label: 'x', issue_repo: B, issue_number: null }
    const pinned = { ...plan, issue_pin_repo: 'owner/pin', issue_pin_number: 7 }
    expect(textRepo(badRow, pinned).repo).toBe('owner/pin')
    expect(textRepo(noNumber, pinned).repo).toBe('owner/pin')
    expect(textRepo(badRow, { ...pinned, issue_pin_number: 0 }).repo).toBe(A)
    expect(textRepo(badRow, { ...plan, issue_pin_repo: 'bad', issue_pin_number: 7 }).repo).toBe(A)
  })

  it('leaves an item, or an entity that is its own identity, on its own repository and folder', () => {
    const item = { id: 'i1', repo: A, repo_root: ROOT, issue_repo: B, issue_number: 585, issue_pin_repo: 'owner/pin', issue_pin_number: 7 }
    expect(textRepo(item, item)).toEqual({ repo: A, root: ROOT })
    expect(textRepo(null, { id: 'i2', repo: A })).toEqual({ repo: A, root: null })
    expect(textRepo(null, null)).toEqual({ repo: null, root: null })
    expect(textRepo({ id: 'i3' }, { id: 'i3' })).toEqual({ repo: null, root: null })
  })

  it('keeps the plan’s folder only while the row reads against the plan’s own repository', () => {
    expect(textRepo({ id: 'r', label: 'x' }, plan)).toEqual({ repo: A, root: ROOT })
    expect(textRepo(linkedRow, plan)).toEqual({ repo: B, root: null })
    // a row linked to its plan's own repository, in another spelling of the slug
    expect(textRepo({ id: 'r', label: 'x', issue_repo: 'OWNER/A', issue_number: 3 }, plan)).toEqual({ repo: 'OWNER/A', root: ROOT })
    expect(textRepo({ id: 'r', label: 'x' }, { ...plan, issue_pin_repo: B, issue_pin_number: 1 })).toEqual({ repo: B, root: null })
    expect(textRepo({ id: 'r', label: 'x' }, { ...plan, issue_pin_repo: 'Owner/A', issue_pin_number: 1 }).root).toBe(ROOT)
  })

  it('has a row with no plan repository read against its own link, with no folder', () => {
    expect(textRepo(linkedRow, { id: 'p2', repo_root: ROOT })).toEqual({ repo: B, root: null })
  })
})

describe('a plan row’s inline links (issue #588)', () => {
  it('open the row’s issue repository, not the plan’s', () => {
    expect(render('PR #585', linkedRow, plan)).toContain('href="https://github.com/owner/b/pull/585"')
    expect(render('see #585', linkedRow, plan)).toContain('href="https://github.com/owner/b/issues/585"')
  })

  it('leave a written owner/name#N and a full URL alone', () => {
    expect(render('see owner/a#12', linkedRow, plan)).toContain('href="https://github.com/owner/a/issues/12"')
    expect(render('https://github.com/owner/c/pull/9', linkedRow, plan)).toContain('href="https://github.com/owner/c/pull/9"')
  })

  it('read a row with no link against the plan’s pin, or else the plan', () => {
    const row = { id: 'r', label: 'x' }
    expect(render('#99', row, { ...plan, issue_pin_repo: B, issue_pin_number: 1 })).toContain('href="https://github.com/owner/b/issues/99"')
    expect(render('#99', row, plan)).toContain('href="https://github.com/owner/a/issues/99"')
  })

  it('leave an item as it was', () => {
    const item = { id: 'i', repo: A }
    expect(render('PR #585', item, item)).toContain('href="https://github.com/owner/a/pull/585"')
  })

  it('keep a repo-relative path plain text beside another repository, and link it beside the plan’s own', () => {
    expect(render('edit docs/spec.md', linkedRow, plan)).not.toContain('data-link-path')
    expect(render('edit docs/spec.md', { id: 'r', label: 'x' }, plan)).toContain('data-link-path="docs/spec.md"')
    expect(render('edit /Users/s/x.md and ~/y.md', linkedRow, plan)).toContain('data-link-path="/Users/s/x.md"')
    expect(render('edit ~/y.md', linkedRow, plan)).toContain('data-link-path="~/y.md"')
  })
})

describe('a plan row’s Links strip (issue #588)', () => {
  const row = { ...linkedRow, label: 'Ship #585', note: 'PR #586 and owner/a#12, docs/spec.md, ~/y.md' }
  const brief = (links: ReturnType<typeof cardLinks>) => links.map((l) => [l.kind, l.label, l.url ?? l.path, l.own])

  it('has the targets and labels the inline text shows', () => {
    expect(brief(cardLinks(row, plan, null))).toEqual([
      ['issue', '#585', 'https://github.com/owner/b/issues/585', true],
      ['pr', '#586', 'https://github.com/owner/b/pull/586', false],
      ['issue', 'owner/a#12', 'https://github.com/owner/a/issues/12', false],
      ['file', 'y.md', '~/y.md', false],
    ])
  })

  it('reads a row with no link against the pin, then the plan, and keeps paths beside the plan’s own repository', () => {
    const bare = { id: 'r', label: 'Do #99', note: 'docs/spec.md' }
    expect(brief(cardLinks(bare, { ...plan, issue_pin_repo: B, issue_pin_number: 1 }, null))).toEqual([
      ['issue', '#1', 'https://github.com/owner/b/issues/1', true],
      ['issue', '#99', 'https://github.com/owner/b/issues/99', false],
    ])
    expect(brief(cardLinks(bare, plan, null))).toEqual([
      ['issue', '#99', 'https://github.com/owner/a/issues/99', false],
      ['file', 'spec.md', 'docs/spec.md', false],
    ])
  })

  it('leaves an item’s strip as it was', () => {
    const item = { id: 'i', repo: A, detail: 'PR #585' }
    expect(brief(cardLinks(item, item, null))).toEqual([['pr', '#585', 'https://github.com/owner/a/pull/585', false]])
  })
})
