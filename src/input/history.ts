export type HistoryCursor = { row: number; rows: number; empty: boolean }

export type HistoryStep = { state: number | null; text: string; cursor: number }

function recall(entries: string[], state: number): HistoryStep {
  const text = entries[state] ?? ""
  return { state, text, cursor: text.length }
}

export function historyStep(
  entries: string[],
  state: number | null,
  direction: "up" | "down",
  cursor: HistoryCursor,
): HistoryStep | null {
  const list = entries.filter((entry, index) => index === 0 || entry !== entries[index - 1])

  if (direction === "up") {
    if (state === null) return cursor.empty && list.length > 0 ? recall(list, list.length - 1) : null
    return cursor.row === 0 && state > 0 ? recall(list, state - 1) : null
  }

  if (state === null || cursor.row !== cursor.rows - 1) return null
  return state < list.length - 1 ? recall(list, state + 1) : { state: null, text: "", cursor: 0 }
}
