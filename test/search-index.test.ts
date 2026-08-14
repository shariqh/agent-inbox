import { describe, expect, it } from 'vitest'
import uFuzzy from '@leeoniya/ufuzzy'
import { buildSearchResults } from '../public/search-index.js'

const uf = new uFuzzy({ intraMode: 1 })
const fuzzy = (hay: string[], needle: string): Array<{ index: number; ranges: number[] }> | null => {
  const [matches, info, order] = uf.search(hay, needle, 0, Number.POSITIVE_INFINITY)
  return info && order
    ? order.map((index) => ({ index: info.idx[index]!, ranges: info.ranges[index] ?? [] }))
    : matches?.map((index) => ({ index, ranges: [] })) ?? null
}

const highlighted = (text: string, ranges: number[]): string => {
  let value = ''
  for (let index = 0; index < ranges.length; index += 2) {
    value += text.slice(ranges[index], ranges[index + 1])
  }
  return value
}

const data = {
  g: {
    needsYou: [{
      project: 'api',
      items: [{
        id: 'q1',
        title: 'Rotate the auth token',
        detail: 'Production credentials expire Friday.',
        project: 'api',
        agent: 'claude',
      }],
    }],
    notes: [{
      project: 'web',
      items: [{
        id: 'n1',
        title: 'Auth cookie workaround',
        project: 'web',
        agent: 'copilot',
      }],
    }],
    done: [{
      id: 'd1',
      title: 'Billing migration',
      project: 'web',
      agent: 'claude',
    }],
  },
  boards: [{
    id: 'b1',
    title: 'Release readiness',
    project: 'api',
    agent: 'claude',
    rows: [{
      id: 'r1',
      label: 'Deploy canary',
      note: 'First region is ready.',
      options: [{ label: 'Ship region one', detail: 'Traffic is safe' }],
    }],
  }],
  archived: [{
    id: 'b2',
    title: 'Old auth spike',
    project: 'infra',
    agent: 'claude',
    rows: [],
  }],
}

describe('buildSearchResults', () => {
  it('returns no index until a query is present', () => {
    expect(buildSearchResults(data, '  ', fuzzy)).toEqual([])
  })

  it('orders and labels result types by their lifecycle hierarchy', () => {
    expect(buildSearchResults(data, 'auth', fuzzy).map(({ targetId, kind, tab, sectionLabel }) => ({
      targetId,
      kind,
      tab,
      sectionLabel,
    }))).toEqual([
      { targetId: 'q1', kind: 'Open item', tab: 'needsYou', sectionLabel: 'Open items' },
      { targetId: 'n1', kind: 'Note', tab: 'notes', sectionLabel: 'Notes' },
      { targetId: 'b2', kind: 'Archived plan', tab: 'boards', sectionLabel: 'Archived plans' },
    ])
  })

  it('surfaces the exact matching plan field and character ranges', () => {
    const [result] = buildSearchResults(data, 'canary', fuzzy)
    expect(result).toMatchObject({
      targetId: 'b1',
      kind: 'Active plan',
      title: 'Release readiness',
      match: {
        label: 'Plan row',
        text: 'Deploy canary',
      },
    })
    expect(highlighted(result!.match!.text, result!.match!.ranges)).toContain('canary')
    expect(buildSearchResults(data, 'traffic', fuzzy)[0]?.match).toMatchObject({
      label: 'Deploy canary · Option detail',
      text: 'Traffic is safe',
    })
  })

  it('marks archived plans as the lowest section and respects the result limit', () => {
    const [result] = buildSearchResults(data, 'auth', fuzzy, 1)
    expect(result?.targetId).toBe('q1')
    expect(buildSearchResults(data, 'old auth', fuzzy)[0]).toMatchObject({
      kind: 'Archived plan',
      sectionLabel: 'Archived plans',
    })
  })

  it('highlights title matches and explains hidden-field matches', () => {
    const [titleMatch] = buildSearchResults(data, 'auth', fuzzy)
    expect(titleMatch?.titleRanges.length).toBeGreaterThan(0)
    expect(highlighted(titleMatch!.title!, titleMatch!.titleRanges)).toBe('auth')
    expect(titleMatch?.match).toBeNull()
    expect(titleMatch?.source).toEqual({
      field: 'title',
      rowId: null,
      text: 'Rotate the auth token',
      fragments: ['auth'],
    })

    const [detailMatch] = buildSearchResults(data, 'credentials', fuzzy)
    expect(detailMatch).toMatchObject({
      targetId: 'q1',
      match: {
        label: 'Details',
        text: 'Production credentials expire Friday.',
      },
      source: {
        field: 'detail',
        rowId: null,
        text: 'Production credentials expire Friday.',
        fragments: ['credentials'],
      },
    })
    expect(highlighted(detailMatch!.match!.text, detailMatch!.match!.ranges)).toBe('credentials')
  })

  it('does not let a trivial title term hide the substantive multi-term evidence', () => {
    const [result] = buildSearchResults(data, 'the credentials', fuzzy)

    expect(highlighted(result!.title, result!.titleRanges)).toBe('the')
    expect(result?.match).toMatchObject({
      label: 'Details',
      text: 'Production credentials expire Friday.',
    })
    expect(highlighted(result!.match!.text, result!.match!.ranges)).toBe('credentials')
  })

  it('shows a hidden-field term even when the longer matching term is in the title', () => {
    const splitData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [{
            id: 'split',
            title: 'Release readiness',
            detail: 'Token expires Friday.',
          }],
        }],
      },
    }
    const [result] = buildSearchResults(splitData, 'release token', fuzzy)

    expect(highlighted(result!.title, result!.titleRanges)).toBe('Release')
    expect(result?.match).toMatchObject({
      label: 'Details',
      text: 'Token expires Friday.',
    })
    expect(highlighted(result!.match!.text, result!.match!.ranges)).toBe('Token')
  })

  it('shows cross-field evidence when title terms appear in the wrong query order', () => {
    const orderedData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [{
            id: 'ordered',
            title: 'Token release',
            context: 'Token only',
          }],
        }],
      },
    }
    const [result] = buildSearchResults(orderedData, 'release token', fuzzy)

    expect(highlighted(result!.title, result!.titleRanges)).toBe('Tokenrelease')
    expect(result?.match).toMatchObject({
      label: 'Background',
      text: 'Token only',
    })
    expect(result?.source).toEqual({
      field: 'context',
      rowId: null,
      text: 'Token only',
      fragments: ['Token'],
    })
    expect(highlighted(result!.match!.text, result!.match!.ranges)).toBe('Token')
  })

  it('identifies the exact plan row that owns hidden-field evidence', () => {
    const [result] = buildSearchResults(data, 'traffic', fuzzy)

    expect(result?.source).toEqual({
      field: 'option-detail',
      rowId: 'r1',
      text: 'Traffic is safe',
      fragments: ['Traffic'],
    })
  })

  it('ranks stronger matches first within current work', () => {
    const rankedData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [
            {
              id: 'weak',
              title: 'Search validation',
              detail: 'Results index coverage is pending.',
              project: 'api',
              agent: 'copilot',
            },
            {
              id: 'strong',
              title: 'Search results index',
              project: 'api',
              agent: 'copilot',
            },
          ],
        }],
      },
    }

    expect(buildSearchResults(rankedData, 'search results', fuzzy).map((result) => result.targetId))
      .toEqual(['strong', 'weak'])
  })

  it('always places current work before stronger historical matches', () => {
    const tieredData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [{
            id: 'open',
            title: 'Deployment follow-up',
            detail: 'Review the deploy checklist.',
            project: 'api',
            agent: 'copilot',
          }],
        }],
        done: [{
          id: 'history',
          title: 'Deploy',
          project: 'api',
          agent: 'copilot',
        }],
      },
    }

    expect(buildSearchResults(tieredData, 'deploy', fuzzy).map((result) => result.targetId))
      .toEqual(['open', 'history'])
  })

  it('uses one obvious hierarchy across every searchable content type', () => {
    const hierarchyData = {
      g: {
        needsYou: [{ project: 'api', items: [{ id: 'open', title: 'Covered open item' }] }],
        notes: [{ project: 'api', items: [{ id: 'note', title: 'Covered note' }] }],
        done: [{ id: 'history', title: 'Covered history' }],
      },
      boards: [{ id: 'plan', title: 'Covered active plan', rows: [] }],
      archived: [{ id: 'archive', title: 'Covered archived plan', rows: [] }],
    }

    expect(buildSearchResults(hierarchyData, 'covered', fuzzy).map(({ targetId, sectionLabel }) => ({
      targetId,
      sectionLabel,
    }))).toEqual([
      { targetId: 'open', sectionLabel: 'Open items' },
      { targetId: 'plan', sectionLabel: 'Active plans' },
      { targetId: 'note', sectionLabel: 'Notes' },
      { targetId: 'history', sectionLabel: 'History' },
      { targetId: 'archive', sectionLabel: 'Archived plans' },
    ])
  })

  it('bounds long hidden-field evidence around the highlighted match', () => {
    const longData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [{
            id: 'long',
            title: 'Policy review',
            context: `${'Earlier background. '.repeat(20)}This service is covered by policy.${' Later background.'.repeat(20)}`,
          }],
        }],
      },
    }

    const [result] = buildSearchResults(longData, 'covered', fuzzy)
    expect(result?.match?.label).toBe('Background')
    expect(result?.match?.text.length).toBeLessThanOrEqual(162)
    expect(result?.match?.text).toMatch(/^…/)
    expect(result?.match?.text).toMatch(/…$/)
    expect(highlighted(result!.match!.text, result!.match!.ranges)).toBe('covered')
  })

  it('indexes top-level decision option labels and details with evidence', () => {
    const optionData = {
      g: {
        needsYou: [{
          project: 'api',
          items: [{
            id: 'decision',
            title: 'Choose the database',
            options: [
              { label: 'PostgreSQL', detail: 'Best fit for relational workloads' },
              { label: 'SQLite', detail: 'Lowest operational overhead' },
            ],
          }],
        }],
      },
    }

    expect(buildSearchResults(optionData, 'PostgreSQL', fuzzy)[0]?.match).toMatchObject({
      label: 'Option',
      text: 'PostgreSQL',
    })
    expect(buildSearchResults(optionData, 'relational', fuzzy)[0]?.match).toMatchObject({
      label: 'PostgreSQL · Option detail',
      text: 'Best fit for relational workloads',
    })
  })
})
