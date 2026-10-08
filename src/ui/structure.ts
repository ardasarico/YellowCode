import type { ItemId, Session } from "../session/types.ts"

export type Row =
  | { kind: "user" | "header" | "markdown" | "agent" | "permission" | "system"; id: ItemId }
  | { kind: "group"; id: ItemId; items: ItemId[] }
  | { kind: "end"; id: ItemId; turnEnds: ItemId[] }

type EndRow = Extract<Row, { kind: "end" }>

export function buildRows(session: Session): Row[] {
  const rows: Row[] = []
  let group: Extract<Row, { kind: "group" }> | null = null
  let lastEnd: EndRow | null = null
  let carried: ItemId[] = []

  for (const id of session.items) {
    const item = session.byId[id]
    if (!item) continue

    const content = item.kind === "text" || item.kind === "thinking" || item.kind === "tool"
    if (content && lastEnd) {
      // Claude went on without a new user message, so this continues the turn that just ended.
      rows.splice(rows.indexOf(lastEnd), 1)
      carried = lastEnd.turnEnds
      const previous = rows.at(-1)
      if (previous?.kind === "group") group = previous
      lastEnd = null
    }
    if (item.kind === "user") {
      lastEnd = null
      carried = []
    }

    const groupable = item.kind === "thinking" || (item.kind === "tool" && item.agent === null)
    if (groupable) {
      if (group) group.items.push(id)
      else rows.push((group = { kind: "group", id, items: [id] }))
      continue
    }
    group = null

    switch (item.kind) {
      case "user":
        rows.push({ kind: "user", id })
        break
      case "turn-start":
        rows.push({ kind: "header", id })
        break
      case "text":
        rows.push({ kind: "markdown", id })
        break
      case "tool":
        rows.push({ kind: "agent", id })
        break
      case "permission":
        rows.push({ kind: "permission", id })
        break
      case "system":
        rows.push({ kind: "system", id })
        break
      case "turn-end":
        rows.push((lastEnd = { kind: "end", id, turnEnds: [...carried, id] }))
        carried = []
        break
    }
  }
  return rows
}
