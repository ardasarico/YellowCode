import type { Item, ItemId, Session } from "../session/types.ts"

export type Row =
  | { kind: "user" | "markdown" | "thinking" | "tool" | "agent" | "system"; id: ItemId }
  | { kind: "end"; id: ItemId; turnEnds: ItemId[] }

type EndRow = Extract<Row, { kind: "end" }>

function rowKind(item: Exclude<Item, { kind: "turn-end" | "ask" }>): Exclude<Row["kind"], "end"> {
  if (item.kind === "text") return "markdown"
  if (item.kind === "tool") return item.agent || item.name === "Agent" || item.name === "Workflow" ? "agent" : "tool"
  return item.kind
}

export function buildRows(session: Session): Row[] {
  const rows: Row[] = []
  let lastEnd: EndRow | null = null
  let carried: ItemId[] = []

  for (const id of session.items) {
    const item = session.byId[id]
    if (!item) continue

    if (item.kind === "ask") continue

    if (item.kind === "turn-end") {
      if (lastEnd) {
        rows.splice(rows.indexOf(lastEnd), 1)
        carried = lastEnd.turnEnds
      }
      rows.push((lastEnd = { kind: "end", id, turnEnds: [...carried, id] }))
      carried = []
      continue
    }
    if (item.kind === "user") {
      lastEnd = null
      carried = []
    } else if (lastEnd && (item.kind === "text" || item.kind === "thinking" || item.kind === "tool")) {
      // Claude went on without a new user message, so this continues the turn that just ended.
      rows.splice(rows.indexOf(lastEnd), 1)
      carried = lastEnd.turnEnds
      lastEnd = null
    }
    rows.push({ kind: rowKind(item), id })
  }
  return rows
}
