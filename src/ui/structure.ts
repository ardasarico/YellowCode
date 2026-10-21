import type { Item, ItemId, Session } from "../session/types.ts"

export type Row =
  | { kind: "user" | "markdown" | "thinking" | "tool" | "agent" | "system" | "shell-end"; id: ItemId }
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
  // An interrupted or failed turn neither absorbs the turn before it nor is absorbed by the next, so what happened
  // stays in view.
  const final = (id: ItemId | undefined) => {
    const item = id === undefined ? undefined : session.byId[id]
    return item?.kind === "turn-end" && (item.interrupted || item.error !== null)
  }
  // The turn end each item leads up to.
  const endAhead: (ItemId | undefined)[] = []
  let ahead: ItemId | undefined
  for (let index = session.items.length - 1; index >= 0; index--) {
    const id = session.items[index]
    if (id !== undefined && session.byId[id]?.kind === "turn-end") ahead = id
    endAhead[index] = ahead
  }

  for (const [index, id] of session.items.entries()) {
    if (id === session.rewound?.userId) break
    const item = session.byId[id]
    if (!item) continue

    if (item.kind === "ask") continue

    if (item.kind === "turn-end") {
      if (lastEnd && !final(lastEnd.id) && !final(id)) {
        rows.splice(rows.indexOf(lastEnd), 1)
        carried = lastEnd.turnEnds
      }
      rows.push((lastEnd = { kind: "end", id, turnEnds: [...carried, id] }))
      carried = []
      continue
    }
    // claude's output for a local command (/model queued behind a turn) is no turn going on.
    const local = item.kind === "text" && item.local === true
    if (item.kind === "user" || local || (lastEnd && (final(lastEnd.id) || final(endAhead[index])))) {
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
