import { describe, expect, it } from 'vitest'
import { buildMission } from '../public/mission.js'
import type { MissionBoard, MissionDep, MissionRow } from '../public/mission.js'
import { buildIssueView } from '../public/issues.js'
import type { IssueViewPlan, IssueViewRow } from '../public/issues.js'
import { buildIssueGraph } from '../src/issue-graph.js'
import type { IssueDependencies } from '../src/store.js'
import { at, depsOf, facts, keySets, row, snapshot } from './issue-fixtures.js'

describe('buildMission', () => {
  it('maps a board into explicit action and next/outcome paths', () => {
    const mission = buildMission({
      id: 'b1',
      title: 'Public launch',
      project: 'oris',
      progress: { done: 1, countable: 3, fraction: 1 / 3 },
      rows: [
        {
          id: 'r1',
          label: 'Merge PR #596',
          status: 'blocked',
          action_owner: 'approval',
          note: 'The PR is ready.',
          impact: 'Ships Apple Notes selection.',
          next_after: 'Continue connector rollout.',
        },
        {
          id: 'r2',
          label: 'Choose tracker',
          status: 'blocked',
          action_owner: 'decision',
          note: 'The outreach kit is ready.',
          next_after: 'Send the first three messages.',
        },
        {
          id: 'r3',
          label: 'Spec merged',
          status: 'done',
          outcome: 'Implementation dispatched.',
        },
        {
          id: 'r4',
          label: 'Not applicable',
          status: 'na',
        },
      ],
    })

    expect(mission.root).toMatchObject({
      id: 'b1',
      title: 'Public launch',
      project: 'oris',
      progress: '1/3',
    })
    expect(mission.paths.map((path) => path.row.id)).toEqual(['r1', 'r2', 'r3'])
    expect(mission.paths[0]!.result).toEqual({ kind: 'next', text: 'Continue connector rollout.' })
    expect(mission.paths[2]!.result).toEqual({ kind: 'outcome', text: 'Implementation dispatched.' })
  })

  it('never invents an edge from impact prose', () => {
    const mission = buildMission({
      id: 'b1',
      title: 'Launch',
      project: 'oris',
      progress: { done: 0, countable: 1, fraction: 0 },
      rows: [{
        id: 'r1',
        label: 'Decision',
        status: 'blocked',
        impact: 'Mentions another row but is not a dependency link.',
      }],
    })
    expect(mission.paths[0]!.result).toBeNull()
  })
})

// Slice 2 PR E (§9.2): both dependency sources in Plan flow, from the same view
// model Plans draws (PR D). The graphs come from the real pure builder.
describe('buildMission with dependencies (slice 2 §9.2)', () => {
  const REPO = 'shariqh/agent-inbox'
  const K = (n: number): string => `${REPO}#${n}`
  const nowMs = Date.parse(at(3))
  const ahp = facts(K(117), { title: 'Integrate AHP' })
  type Step = MissionRow & IssueViewRow
  const step = (id: string, label: string, status: MissionRow['status'], link: number | null, waits: string[] = [], extra: Partial<Step> = {}): Step => ({
    id, label, status, waits_on: waits, ...(link === null ? {} : { issue_repo: REPO, issue_number: link }), ...extra,
  })
  const planOf = (id: string, title: string, rows: Step[], pin: number | null = 117): MissionBoard & IssueViewPlan => ({
    id, title, project: 'agent-inbox', agent: 'copilot', status: 'active', repo: REPO, stream: 'main', issue_ref: null,
    issue_pin_repo: pin === null ? null : REPO, issue_pin_number: pin, progress: { done: 0, countable: rows.length, fraction: 0 }, rows,
  } as MissionBoard & IssueViewPlan)

  /**
   * AHP, pinned to #117: Import requests waits on the step Build, on AHP adapter
   * (also #120's GitHub blocker #119) and on #130, which another plan works on.
   * #119 also unblocks #131, which nobody here links. Control's issue sits under
   * #200, not #117. #140 is #117's child that no row links.
   */
  function fixture() {
    const rows = [
      step('rb', 'Build', 'tracked', null),
      step('ra', 'AHP adapter', 'partial', 119),
      step('ri', 'Import requests', 'tracked', 120, ['Build', 'AHP adapter', 'Gone'], { next_after: 'After Build lands, ship #131.' }),
      step('rd', 'Docs', 'done', 122),
      step('rx', 'Extra', 'tracked', null, ['Docs']),
      step('rn', 'Skipped', 'na', 124),
      step('ry', 'Later', 'tracked', null, ['Skipped']),
      step('rc', 'Control', 'tracked', 125),
    ]
    const plan = planOf('p', 'AHP', rows)
    const other = planOf('o', 'Elsewhere', [step('ro', 'Gateway', 'partial', 130)], null)
    const pairs = depsOf([[K(119), K(120)], [K(130), K(120)], [K(119), K(131)]])
    const under117 = { ancestors: [ahp] }
    const snaps = [
      row(K(117), snapshot(K(117), { issue: { title: 'Integrate AHP' }, children: [K(119), K(120), K(122), K(124), facts(K(140), { title: 'Telemetry' })] }), at(0), { dependencies: pairs(K(117)) }),
      ...[119, 120, 122, 124].map((n) => row(K(n), snapshot(K(n), under117), at(0), { dependencies: pairs(K(n)) })),
      row(K(125), snapshot(K(125), { ancestors: [facts(K(200), { title: 'Platform' })] }), at(0), { dependencies: pairs(K(125)) }),
      row(K(130), snapshot(K(130)), at(0), { dependencies: pairs(K(130)) }),
    ]
    const graph = buildIssueGraph(snaps, keySets(snaps.map((r) => `${r.repo}#${r.number}`)))
    const issues = buildIssueView(graph, { boards: [plan, other], nowMs })
    return { plan, issues }
  }
  const brief = (entries: readonly MissionDep[]) => entries.map((e) => (e.kind === 'step'
    ? `step ${e.label}${e.issue ? ` #${e.issue.number}` : ''} [${e.sources.join('+')}]`
    : `issue ${e.node.key} ${e.activity?.label}`))
  const pathOf = (mission: ReturnType<typeof buildMission>, id: string) => mission.paths.find((p) => p.row.id === id)!

  it('keeps the row order and draws merged waits-on, its exact inverse, and external issues with their activity', () => {
    const { plan, issues } = fixture()
    const mission = buildMission(plan, { issues, links: null })
    expect(mission.paths.map((p) => p.row.id)).toEqual(['rb', 'ra', 'ri', 'rd', 'rx', 'ry', 'rc'])
    // the step AHP adapter and #120's GitHub blocker #119 are one entry; the dangling "Gone" draws nothing
    expect(brief(pathOf(mission, 'ri').waitsOn)).toEqual([
      'step Build [step]',
      'step AHP adapter #119 [step+github]',
      `issue ${K(130)} Active · copilot · Gateway`,
    ])
    const external = pathOf(mission, 'ri').waitsOn[2]!
    expect(external.kind === 'issue' && external.activity?.target).toEqual({ id: 'o', rowId: 'ro' })
    expect(brief(pathOf(mission, 'rb').unblocks)).toEqual(['step Import requests #120 [step]'])
    expect(brief(pathOf(mission, 'ra').unblocks)).toEqual(['step Import requests #120 [step+github]', `issue ${K(131)} None here`])
    // a done target and an na target are satisfied: nothing waits, nothing unblocks
    expect(pathOf(mission, 'rx').waitsOn).toEqual([])
    expect(pathOf(mission, 'ry').waitsOn).toEqual([])
    expect(pathOf(mission, 'rd').unblocks).toEqual([])
    // next_after prose is a result, never an edge: these are every edge there is
    expect(pathOf(mission, 'ri').result).toEqual({ kind: 'next', text: 'After Build lands, ship #131.' })
    expect(mission.paths.map((p) => [p.row.id, brief(p.waitsOn), brief(p.unblocks)] as const).filter(([, w, u]) => w.length || u.length)).toEqual([
      ['rb', [], ['step Import requests #120 [step]']],
      ['ra', [], ['step Import requests #120 [step+github]', `issue ${K(131)} None here`]],
      ['ri', ['step Build [step]', 'step AHP adapter #119 [step+github]', `issue ${K(130)} Active · copilot · Gateway`], []],
    ])
    expect(mission.paths.every((p) => !p.circular)).toBe(true)
  })

  it('draws a containment rail only where the parent differs, and folds the plan issue\'s unlinked children', () => {
    const { plan, issues } = fixture()
    const mission = buildMission(plan, { issues, links: null })
    expect(mission.paths.filter((p) => p.partOf).map((p) => [p.row.id, p.partOf!.node.key])).toEqual([['rc', K(200)]])
    // #122 is linked by a done row and #124 by an na row: only #140 is outside
    expect(mission.outside?.list.map((c) => [c.node.key, c.activity.label])).toEqual([[K(140), 'None here']])
    expect(mission.outside?.freshness).toBe('fresh')
  })

  it('links a GitHub blocker that another row of this plan links, from either side, and never across plans', () => {
    const { plan } = fixture()
    // #131 joins the plan: #119 now unblocks the step Review, which waits on it only on GitHub
    const joined = { ...plan, rows: [...plan.rows, step('rv', 'Review', 'tracked', 131)] }
    const pairs = depsOf([[K(119), K(120)], [K(130), K(120)], [K(119), K(131)]])
    // #131 itself was never fetched, so the edge is known only from #119's side
    const mission = buildMission(joined, { issues: buildIssueView(rebuild(pairs, [131]), { boards: [joined], nowMs }), links: null })
    expect(brief(pathOf(mission, 'ra').unblocks)).toEqual(['step Import requests #120 [step+github]', 'step Review #131 [github]'])
    expect(brief(pathOf(mission, 'rv').waitsOn)).toEqual(['step AHP adapter #119 [github]'])
    // the other plan is never a step here
    expect(pathOf(mission, 'ri').waitsOn.some((e) => e.kind === 'step' && e.rowId === 'ro')).toBe(false)
  })

  /** #117, #119 and #120 fetched; `unfetched` linked but never fetched. */
  function rebuild(pairs: (key: string) => IssueDependencies, unfetched: number[]) {
    const under117 = { ancestors: [ahp] }
    const snaps = [
      row(K(117), snapshot(K(117), { children: [K(119), K(120)] }), at(0), { dependencies: pairs(K(117)) }),
      ...[119, 120].map((n) => row(K(n), snapshot(K(n), under117), at(0), { dependencies: pairs(K(n)) })),
    ]
    return buildIssueGraph(snaps, keySets([...snaps.map((r) => `${r.repo}#${r.number}`), ...unfetched.map(K)]))
  }

  it('marks every member of a GitHub cycle or a local waits_on cycle "circular" and keeps the order', () => {
    const rows = [
      step('r1', 'One', 'tracked', 150),
      step('r2', 'Two', 'tracked', null, ['Three']),
      step('r3', 'Three', 'tracked', null, ['Two']),
      step('r4', 'Four', 'tracked', 151),
      step('r5', 'Five', 'tracked', null, ['Two']),
    ]
    const plan = planOf('p', 'Loops', rows, null)
    const pairs = depsOf([[K(150), K(151)], [K(151), K(150)]])
    const snaps = [150, 151].map((n) => row(K(n), snapshot(K(n)), at(0), { dependencies: pairs(K(n)) }))
    const issues = buildIssueView(buildIssueGraph(snaps, keySets(snaps.map((r) => `${r.repo}#${r.number}`))), { boards: [plan], nowMs })
    const mission = buildMission(plan, { issues, links: null })
    expect(mission.paths.map((p) => [p.row.id, p.circular])).toEqual([
      ['r1', true], ['r2', true], ['r3', true], ['r4', true], ['r5', false],
    ])
  })

  it('draws no edge, rail or fold without a graph, and only steps from waits_on', () => {
    const { plan } = fixture()
    const issues = buildIssueView(null, { boards: [plan], nowMs })
    const mission = buildMission(plan, { issues, links: null })
    expect(brief(pathOf(mission, 'ri').waitsOn)).toEqual(['step Build [step]', 'step AHP adapter #119 [step]'])
    expect(mission.paths.some((p) => p.partOf)).toBe(false)
    expect(mission.outside).toBeNull()
    // and no deps at all is the slice-1 flow
    const bare = buildMission(plan)
    expect(bare.paths.every((p) => !p.waitsOn.length && !p.unblocks.length && !p.partOf && !p.circular)).toBe(true)
    expect(bare.outside).toBeNull()
  })
})
