export type HistoryCursor = { row: number; rows: number; empty: boolean }

// `entry` is null when the step leaves the history for an empty prompt. `total` counts the entries without repeats.
export type HistoryStep<T> = { state: number | null; entry: T | null; cursor: number; total: number }

function recall<T extends { text: string }>(entries: T[], state: number): HistoryStep<T> {
  const entry = entries[state] ?? null
  return { state, entry, cursor: entry?.text.length ?? 0, total: entries.length }
}

export function historyStep<T extends { text: string }>(
  entries: T[],
  state: number | null,
  direction: "up" | "down",
  cursor: HistoryCursor,
): HistoryStep<T> | null {
  const list = entries.filter((entry, index) => index === 0 || entry.text !== entries[index - 1]?.text)

  if (direction === "up") {
    if (state === null) return cursor.empty && list.length > 0 ? recall(list, list.length - 1) : null
    return cursor.row === 0 && state > 0 ? recall(list, state - 1) : null
  }

  if (state === null || cursor.row !== cursor.rows - 1) return null
  return state < list.length - 1 ? recall(list, state + 1) : { state: null, entry: null, cursor: 0, total: list.length }
}
