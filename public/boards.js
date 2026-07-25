// Pure board-matrix helpers (spec §9). No DOM: the Boards tab renders from these.
// Sibling public modules are imported RELATIVELY so the same file resolves in the
// browser (/boards.js → /attention.js) and under vitest.
import { isBlockedRowAttention } from './attention.js'

// hide-completed hides `done` rows unless this board opted back in; `num` keeps the
// ORIGINAL 1-based index so "row N" references stay stable when rows are hidden.
export function boardRowsView(board, { hideCompleted = false, showDone = false } = {}) {
  return board.rows
    .map((row, i) => ({ row, num: i + 1, needsAnswer: isBlockedRowAttention(row) }))
    .filter(({ row }) => !(hideCompleted && !showDone && row.status === 'done'))
}

// done/countable is the primary reading; the percentage is secondary (spec §9).
export function progressLabel(progress) {
  return {
    primary: `${progress.done}/${progress.countable}`,
    secondary: `${Math.round(progress.fraction * 100)}%`,
    complete: progress.fraction === 1 && progress.countable > 0,
  }
}

// how many done rows this board is currently hiding — drives its "N hidden — show" hint
export function hiddenDoneCount(board, { hideCompleted = false, showDone = false } = {}) {
  if (!hideCompleted || showDone) return 0
  return board.rows.filter((r) => r.status === 'done').length
}

// Boards the human watched reach 100% and that their agent then archived. They
// stay on screen for the rest of the session instead of blinking out of the list
// (spec §9) — `prevActiveIds` is every board id seen active so far this session.
export function lingeringBoards(prevActiveIds, boards, archived) {
  const seen = new Set(prevActiveIds)
  const live = new Set(boards.map((b) => b.id))
  return archived.filter((b) =>
    seen.has(b.id) && !live.has(b.id) && b.progress.fraction === 1 && b.progress.countable > 0)
}
