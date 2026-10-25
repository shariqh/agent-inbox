import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const docs = resolve(process.cwd(), 'docs')
const RELEASE_DOCS = ['macos-release.md', 'linux-release.md', 'windows-release.md']

// The anchors GitHub gives a document's headings: the heading's text in lower case, with
// punctuation other than - and _ dropped and each space made a hyphen, and -1, -2, …
// appended to a repeated one. Headings inside fenced code are not headings.
function headingAnchors(markdown: string): string[] {
  const anchors: string[] = []
  const repeats = new Map<string, number>()
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading?.[1]) continue
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-')
    const seen = repeats.get(slug) ?? 0
    repeats.set(slug, seen + 1)
    anchors.push(seen ? `${slug}-${seen}` : slug)
  }
  return anchors
}

describe('release docs', () => {
  it('link only to headings that exist, within and between the three release docs (#362)', () => {
    const text = Object.fromEntries(RELEASE_DOCS.map((doc) => [doc, readFileSync(join(docs, doc), 'utf8')]))
    let checked = 0
    for (const doc of RELEASE_DOCS) {
      for (const [, target, anchor] of text[doc]!.matchAll(/\]\(([\w.-]*\.md)?#([^)\s]+)\)/g)) {
        const linked = target ?? doc
        if (!RELEASE_DOCS.includes(linked)) continue
        expect(headingAnchors(text[linked]!), `${doc} links to ${linked}#${anchor}`).toContain(anchor)
        checked += 1
      }
    }
    // the cross-document links this exists for, so the scan cannot pass by finding none
    for (const doc of ['linux-release.md', 'windows-release.md']) {
      expect(text[doc], doc).toContain('(macos-release.md#node-24220-ends-the-135-compatibility-hold)')
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('derives the anchors GitHub gives these headings', () => {
    expect(headingAnchors([
      '### What node_modules ships (#291)',
      "#### Electron's embedded Node",
      '## Per-user MSI (#87, PR 2b)',
      '```sh',
      '# not a heading',
      '```',
      '### Node 24.22.0 ends the #135 compatibility hold',
      '## Notes',
      '## Notes',
    ].join('\n'))).toEqual([
      'what-node_modules-ships-291',
      'electrons-embedded-node',
      'per-user-msi-87-pr-2b',
      'node-24220-ends-the-135-compatibility-hold',
      'notes',
      'notes-1',
    ])
  })
})
