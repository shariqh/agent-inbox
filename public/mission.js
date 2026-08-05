export function buildMission(board) {
  const done = board?.progress?.done ?? 0
  const countable = board?.progress?.countable ?? 0
  return {
    root: {
      id: board.id,
      title: board.title,
      project: board.project,
      progress: `${done}/${countable}`,
    },
    paths: (board.rows ?? [])
      .filter((row) => row.status !== 'na')
      .map((row) => ({
        row,
        result: row.outcome
          ? { kind: 'outcome', text: row.outcome }
          : row.next_after ? { kind: 'next', text: row.next_after } : null,
      })),
  }
}
