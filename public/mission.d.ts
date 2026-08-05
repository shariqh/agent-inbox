export interface MissionRow {
  id: string
  label: string
  status: 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'
  action_owner?: 'decision' | 'task' | 'approval' | null
  note?: string
  impact?: string
  next_after?: string
  outcome?: string
}

export interface MissionBoard {
  id: string
  title: string
  project: string
  progress: { done: number; countable: number; fraction: number }
  rows: MissionRow[]
}

export function buildMission(board: MissionBoard): {
  root: { id: string; title: string; project: string; progress: string }
  paths: Array<{
    row: MissionRow
    result: { kind: 'next' | 'outcome'; text: string } | null
  }>
}
