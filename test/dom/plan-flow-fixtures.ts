// Slice 2 PR E (§9.2): a plan whose rows wait on each other and on GitHub
// issues, for the Plan flow DOM tests. Deliberately NOT named *.test.ts.
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard, upsertIssueSnapshot } from '../../src/store.js'
import { deps, facts, snapshot } from '../issue-fixtures.js'
import type { DepsOpts, SnapshotOpts } from '../issue-fixtures.js'
import { buttonLabelled, click, settle } from './harness.js'

// Seeded through store.ts exactly as the poller and an agent's board_upsert write them.
const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const SCOPE = { project: 'agent-inbox', agent: 'copilot' }

function cache(d: Database.Database, n: number, snap: SnapshotOpts = {}, dep: DepsOpts = {}): void {
  upsertIssueSnapshot(d, {
    repo: REPO, number: n, startedAt: new Date().toISOString(),
    snapshot: snapshot(K(n), { issue: { title: `Issue ${n}` }, ...snap }), dependencies: deps(dep),
  })
}

/**
 * AHP, pinned to #117: Import requests waits on the step Build and on AHP
 * adapter (#119, also its GitHub blocker), and on #130, which the plan Gateway
 * work owns. Control (#125) sits under #200. #140 is #117's unlinked child.
 */
export function seedFlow(d: Database.Database) {
  upsertBoard(d, {
    ...SCOPE, stream: 'main', title: 'AHP', repo: REPO, issuePin: { repo: REPO, number: 117 },
    rows: [
      { label: 'Build', status: 'tracked', note: 'Build it.' },
      { label: 'AHP adapter', status: 'partial', note: 'Adapter work.', issue: { repo: REPO, number: 119 } },
      { label: 'Import requests', status: 'tracked', note: 'Import.', issue: { repo: REPO, number: 120 }, waits_on: ['Build', 'AHP adapter'],
        next_after: 'Then ship #131.' },
      { label: 'Control', status: 'tracked', note: 'Control plane.', issue: { repo: REPO, number: 125 } },
    ],
  })
  upsertBoard(d, {
    ...SCOPE, stream: 'gateway', title: 'Gateway work', repo: REPO,
    rows: [{ label: 'Gateway', status: 'partial', note: 'The gateway note.', issue: { repo: REPO, number: 130 } }],
  })
  const under117 = { ancestors: [facts(K(117), { title: 'Integrate AHP' })] }
  cache(d, 117, { issue: { title: 'Integrate AHP' }, children: [K(119), K(120), facts(K(140), { title: 'Telemetry' })] })
  cache(d, 119, under117, { blocking: [K(120)] })
  cache(d, 120, under117, { blockedBy: [K(119), facts(K(130), { title: 'Issue 130' })] })
  cache(d, 125, { ancestors: [facts(K(200), { title: 'Platform' })] })
  cache(d, 130, {}, { blocking: [K(120)] })
  const plan = getBoard(d, 'agent-inbox', 'AHP')!
  const other = getBoard(d, 'agent-inbox', 'Gateway work')!
  return { plan, other, id: (label: string) => plan.rows.find((r) => r.label === label)!.id }
}

export async function openFlow(planId: string): Promise<HTMLElement> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
  click(buttonLabelled('Plan flow', document.querySelector(`#boards [data-card-id="${planId}"]`)!))
  await settle()
  return document.getElementById('missionbox')!
}

export const flowPath = (rowId: string): HTMLElement =>
  document.querySelector<HTMLElement>(`#missionbox .mission-path[data-row-id="${rowId}"]`)!
export const stepButton = (scope: ParentNode, name: string): HTMLButtonElement =>
  [...scope.querySelectorAll<HTMLButtonElement>('button.mission-step-link')].find((b) => b.getAttribute('aria-label') === name)!
