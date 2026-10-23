import { z } from "zod"
import { shownItems } from "./rewind.ts"
import type { ItemId, Session, ToolCall } from "./types.ts"

export type TodoState = "pending" | "active" | "done"
export type Todo = { id: string; text: string; state: TodoState }

// Claude keeps its task list with TaskCreate/TaskUpdate, or TodoWrite on its own; both are off by default on recent
// models, so the list shows only when they are on.
export const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"])

const fields = z.record(z.string(), z.unknown())
const record = (value: unknown): Record<string, unknown> => fields.safeParse(value).data ?? {}
const text = (value: unknown) => (typeof value === "string" ? value : "")

function stateOf(status: unknown): TodoState | null {
  if (status === "in_progress") return "active"
  if (status === "completed") return "done"
  if (status === "pending") return "pending"
  return null
}

function apply(list: Todo[], tool: ToolCall): Todo[] {
  const input = record(tool.input)
  if (tool.name === "TodoWrite" && Array.isArray(input.todos))
    return input.todos.map((entry, index) => {
      const todo = record(entry)
      return { id: String(index + 1), text: text(todo.content), state: stateOf(todo.status) ?? "pending" }
    })
  if (tool.name === "TaskCreate") {
    // The id comes with the result; until then the call stands in for it.
    const id = /Task #(\S+) created/.exec(tool.result)?.[1] ?? tool.id
    return [...list, { id, text: text(input.subject), state: "pending" }]
  }
  if (tool.name === "TaskUpdate") {
    const id = text(input.taskId)
    if (input.status === "deleted") return list.filter((todo) => todo.id !== id)
    return list.map((todo) =>
      todo.id === id
        ? { ...todo, text: text(input.subject) || todo.text, state: stateOf(input.status) ?? todo.state }
        : todo,
    )
  }
  return list
}

const mainTodoCalls = (session: Session): ToolCall[] =>
  shownItems(session.items, session.rewound).flatMap((id) => {
    const item = session.byId[id]
    return item?.kind === "tool" && TODO_TOOLS.has(item.name) && item.status !== "error" ? [item] : []
  })

export function todoList(session: Session): Todo[] {
  return mainTodoCalls(session).reduce(apply, [])
}

export type TodoChange =
  | { kind: "planned"; count: number }
  | { kind: "started" | "finished" | "added"; text: string; more: number }

// What one call changed, for its line in the chat. Creations in a row read as one line on the last of them.
export function todoChange(session: Session, id: ItemId): TodoChange | null {
  const calls = mainTodoCalls(session)
  const at = calls.findIndex((call) => call.id === id)
  const call = calls[at]
  if (!call || call.name === "TaskList" || call.name === "TaskGet") return null
  const before = calls.slice(0, at).reduce(apply, [])
  const after = apply(before, call)
  if (call.name === "TaskCreate") {
    if (calls[at + 1]?.name === "TaskCreate") return null
    let first = at
    while (calls[first - 1]?.name === "TaskCreate") first--
    return { kind: "planned", count: at - first + 1 }
  }
  if (before.length === 0) return { kind: "planned", count: after.length }
  const was = new Map(before.map((todo) => [todo.id, todo.state]))
  const started = after.filter((todo) => todo.state === "active" && was.get(todo.id) !== "active")
  const finished = after.filter((todo) => todo.state === "done" && was.get(todo.id) !== "done")
  const added = after.filter((todo) => !was.has(todo.id))
  const ordered = [
    ...started.map((todo) => ({ kind: "started" as const, text: todo.text })),
    ...finished.map((todo) => ({ kind: "finished" as const, text: todo.text })),
    ...added.map((todo) => ({ kind: "added" as const, text: todo.text })),
  ]
  const head = ordered[0]
  return head ? { ...head, more: ordered.length - 1 } : null
}
