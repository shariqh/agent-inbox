import { describe, expect, it } from 'vitest'
import { buildMission } from '../public/mission.js'

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
