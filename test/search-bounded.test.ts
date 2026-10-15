import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const moduleUrl = new URL('../public/search-index.js', import.meta.url).href
const context = 'The release plan verifies native packaging, update signatures, and agent setup. Current checks cover the macOS package and Linux installer. The release candidate passed its unit tests and source compilation. The remaining work is to compare the generated package checksum against the signed manifest and confirm the installer works on a clean account. We will not change configuration outside the managed instruction block. The rollback plan retains the prior runtime until the smoke test completes. The staging path uses an isolated account and synthetic fixture records. Known limitations: the end-to-end smoke test runs locally and is not a guarantee for every host. A separate test checks that unsuccessful writes leave the human response recoverable. The approval controls should expose direct choices without hiding the impact of the decision. After the release is approved, publish the existing artifact and record the URL and resulting version. Keep the current stable artifact if any identity or checksum check fails. The plan includes a final verification that the desktop app starts, connects its viewer, and displays the expected version. Follow-up work covers Windows packaging and does not block the current release. Reviewer notes should identify a reproducible condition, not hypothetical changes to the threat model. The completed work is recorded separately from pending decisions, and the board row stays active until its owner records the outcome.'

function runSearch(boards: number, timeout: number, misordered = false) {
  const script = `
    import { readFileSync } from 'node:fs'
    import { performance } from 'node:perf_hooks'
    import { buildSearchResults } from ${JSON.stringify(moduleUrl)}
    const UFuzzy = new Function(readFileSync('public/ufuzzy.iife.min.js', 'utf8') + '; return uFuzzy')()
    const uf = new UFuzzy({ intraMode: 1 })
    const fuzzy = (hay, needle) => {
      const [matches, info, order] = uf.search(hay, needle, 0, Infinity)
      return info && order
        ? order.map(index => ({ index: info.idx[index], ranges: info.ranges[index] ?? [] }))
        : matches?.map(index => ({ index, ranges: [] })) ?? null
    }
    const data = {
      g: { done: [{ id: 'finished-900', title: 'Release completed work 900' }] },
      boards: Array.from({ length: ${boards} }, (_, index) => ({
        id: 'plan-' + index, title: ${JSON.stringify(misordered ? '900 Release plan ' : 'Release plan ')} + index,
        rows: Array.from({ length: 20 }, (_, row) => ({
          id: 'row-' + row, label: 'Step ' + row, context: ${JSON.stringify(context)},
        })),
      })),
    }
    const started = performance.now()
    const results = buildSearchResults(data, 'release completed work 900', fuzzy)
    process.stdout.write(JSON.stringify({ ms: performance.now() - started, results }))
  `
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd: root, input: script, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  })
}

describe('bounded workspace matching', () => {
  it.each([
    { boards: 1, timeout: 2500, budget: 750, misordered: false },
    { boards: 50, timeout: 4000, budget: 1500, misordered: false },
    { boards: 1, timeout: 2500, budget: 750, misordered: true },
  ])('finds an exact History title behind $boards long plans (all terms present: $misordered)', ({ boards, timeout, budget, misordered }) => {
    expect(context).toHaveLength(1467)
    const run = runSearch(boards, timeout, misordered)
    expect(run.error, `search exceeded its independent ${timeout}ms process deadline`).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout) as {
      ms: number
      results: Array<{ targetId: string; section: string; titleRanges: number[] }>
    }
    expect(result.ms).toBeLessThan(budget)
    expect(result.results.map((item) => item.targetId)).toEqual(['finished-900'])
    expect(result.results[0]?.section).toBe('history')
    expect(result.results[0]?.titleRanges).toEqual([0, 7, 8, 17, 18, 22, 23, 26])
  })
})
