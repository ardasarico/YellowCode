import type { ToolKind } from "../agent/tools.ts"
import { hiddenSpan } from "../session/rewind.ts"
import { shownTools } from "../session/shells.ts"
import { todoChange } from "../session/todos.ts"
import { isBackgroundShell } from "../session/tool-summary.ts"
import type { Ask, Item, ItemId, Session, ToolCall } from "../session/types.ts"

// The band that stands for the items a rewind hides.
export const REWOUND_ROW = "rewound"

export type Row =
  | {
      kind: "user" | "markdown" | "thinking" | "tool" | "brief" | "agent" | "system" | "shell-end" | "rewound"
      id: ItemId
    }
  | { kind: "end"; id: ItemId; turnEnds: ItemId[] }
  | { kind: "group"; id: string; members: ItemId[] }

type EndRow = Extract<Row, { kind: "end" }>

function rowKind(item: Exclude<Item, { kind: "turn-end" | "ask" }>): Exclude<Row["kind"], "end" | "group"> {
  if (item.kind === "text") return "markdown"
  if (item.kind === "tool")
    return item.agent || item.toolKind === "agent" || item.toolKind === "workflow" ? "agent" : "tool"
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

  const span = hiddenSpan(session.items, session.rewound)
  let shown: Set<ItemId> | null = null
  // Messages waiting for the agent stay below everything until it takes them in (see moveToEnd in the session).
  const waiting: ItemId[] = []
  for (const [index, id] of session.items.entries()) {
    if (span && index >= span.start && index < span.end) {
      if (index === span.start) {
        rows.push({ kind: "rewound", id: REWOUND_ROW })
        lastEnd = null
        carried = []
      }
      continue
    }
    const item = session.byId[id]
    if (!item) continue
    // A shell the rewound prompts started can end after the rewind, and stays out after the next send.
    if (item.kind === "shell-end") {
      shown ??= shownTools(session)
      const call = session.tasks[item.taskId]?.toolUseId
      if (call && session.byId[call] && !shown.has(call)) continue
    }

    if (item.kind === "ask") continue
    if (item.kind === "user" && item.queue === "queued") {
      waiting.push(id)
      continue
    }
    if ((item.kind === "text" || item.kind === "tool") && item.quiet && !(item.kind === "tool" && item.agent)) continue
    if (item.kind === "tool" && item.toolKind === "todo" && !todoChange(session, id)) continue

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
      // The agent went on without a new user message, so this continues the turn that just ended.
      rows.splice(rows.indexOf(lastEnd), 1)
      carried = lastEnd.turnEnds
      lastEnd = null
    }
    rows.push({ kind: rowKind(item), id })
  }
  return [...fold(session, rows), ...waiting.map((id): Row => ({ kind: "user", id }))]
}

const FOLDED_KINDS = new Set<ToolKind>(["shell", "read", "search"])

function foldable(session: Session, asks: Map<string, Ask>, tool: ToolCall): boolean {
  if (!FOLDED_KINDS.has(tool.toolKind) || (tool.status !== "done" && tool.status !== "error")) return false
  if (tool.local || tool.images.length > 0) return false
  if (isBackgroundShell(tool, session.tasks[tool.taskId ?? ""] ?? null)) return false
  const ask = asks.get(tool.id)
  return !ask || ask.status === "allowed" || ask.status === "answered"
}

// Finished reads, searches and commands shrink to one line, and those in a row with only thoughts between them
// share one once something else follows; until then each keeps its own line, so the work is seen going on. A
// finished thought stays only right before the agent's reply.
function fold(session: Session, rows: Row[]): Row[] {
  const asks = new Map<string, Ask>()
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "ask") asks.set(item.toolUseId, item)
  }
  const folded = (row: Row) => {
    const item = session.byId[row.id]
    return row.kind === "tool" && item?.kind === "tool" && foldable(session, asks, item)
  }
  const finishedThought = (row: Row) => {
    const item = session.byId[row.id]
    return row.kind === "thinking" && item?.kind === "thinking" && !item.streaming
  }

  const running = (row: Row) => {
    const item = session.byId[row.id]
    return row.kind === "tool" && item?.kind === "tool" && FOLDED_KINDS.has(item.toolKind) && item.status === "running"
  }
  let tail = rows.length
  while (tail > 0) {
    const row = rows[tail - 1]
    if (!row || !(folded(row) || running(row) || row.kind === "thinking")) break
    tail--
  }

  const out: Row[] = []
  let run: Row[] = []
  const flush = () => {
    const first = run.findIndex(folded)
    if (first === -1) {
      out.push(...run)
    } else {
      const last = run.findLastIndex(folded)
      const members = run.slice(first, last + 1)
      const lead = members[0]
      out.push(...run.slice(0, first))
      if (lead && members.filter(folded).length === 1) out.push({ kind: "brief", id: lead.id })
      else if (lead) out.push({ kind: "group", id: `${lead.id}/group`, members: members.map((row) => row.id) })
      out.push(...run.slice(last + 1))
    }
    run = []
  }
  for (const row of rows.slice(0, tail)) {
    if (folded(row) || finishedThought(row)) {
      run.push(row)
      continue
    }
    flush()
    out.push(row)
  }
  flush()
  for (const row of rows.slice(tail)) out.push(folded(row) ? { kind: "brief", id: row.id } : row)
  return out.filter((row, index) => !finishedThought(row) || out[index + 1]?.kind === "markdown")
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

export function groupLabel(session: Session, members: ItemId[]): { text: string; failed: number } {
  const tools = members.flatMap((id) => {
    const item = session.byId[id]
    return item?.kind === "tool" ? [item] : []
  })
  const counted = (kind: ToolKind) => tools.filter((tool) => tool.toolKind === kind).length
  const clauses: [number, string, string][] = [
    [counted("shell"), "ran", "shell command"],
    [counted("read"), "read", "file"],
    [counted("search"), "searched", "pattern"],
  ]
  const text = clauses.flatMap(([n, verb, noun]) => (n > 0 ? [`${verb} ${plural(n, noun)}`] : [])).join(", ")
  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    failed: tools.filter((tool) => tool.status === "error").length,
  }
}
