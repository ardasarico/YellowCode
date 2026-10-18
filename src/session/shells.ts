import { unwrap } from "solid-js/store"
import type { ItemId, Session, Task } from "./types.ts"

export function isShell(task: Task): boolean {
  return task.type === "local_bash" && task.background
}

// The tool calls the chat still shows, subagents' included: none from a rewind's prompt on, none a later send dropped.
function shownTools(session: Session): Set<ItemId> {
  const byId = unwrap(session.byId)
  const shown = new Set<ItemId>()
  const visit = (id: ItemId) => {
    const item = byId[id]
    if (item?.kind !== "tool") return
    shown.add(id)
    for (const child of item.children) visit(child)
  }
  for (const id of session.items) {
    if (id === session.rewound?.userId) break
    visit(id)
  }
  return shown
}

// A shell goes with the prompt that started it; one whose call never arrived stays.
function shownShells(session: Session): Task[] {
  const shells = Object.values(session.tasks).filter(isShell)
  if (shells.length === 0) return shells
  const shown = shownTools(session)
  const byId = unwrap(session.byId)
  return shells.filter((task) => !task.toolUseId || !byId[task.toolUseId] || shown.has(task.toolUseId))
}

// Running shells newest start first, then finished shells latest end first.
export function shellTasks(session: Session): Task[] {
  const shells = shownShells(session)
  const running = shells
    .filter((task) => task.state === "running")
    .toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const ended = shells
    .filter((task) => task.state !== "running")
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...ended]
}

export function runningShellCount(session: Session): number {
  return shownShells(session).filter((task) => task.state === "running").length
}

// The model-written description inside the summary can itself say "exit code N", so only the summary's end counts.
// A stopped shell has no code, and its summary is only that description.
export function exitCode(task: Task): number | null {
  if (task.state === "stopped") return null
  const code =
    task.summary.trim().match(/exit code (\d+)\)?$/)?.[1] ??
    lastCapture(task.output ?? "", /\[exited with code (\d+)\]/g)
  return code === undefined ? null : Number(code)
}

function lastCapture(text: string, pattern: RegExp): string | undefined {
  return [...text.matchAll(pattern)].at(-1)?.[1]
}

export function shellStartedBy(session: Session, task: Task): string {
  const parent = task.parentId ? session.tasks[task.parentId] : undefined
  if (parent?.name) return parent.name
  const toolUseId = task.toolUseId
  if (toolUseId) {
    for (const item of Object.values(session.byId)) {
      if (item.kind === "tool" && item.agent && item.children.includes(toolUseId)) return item.agent.name
    }
  }
  return "main"
}

export function stoppedByTimeLimit(task: Task): boolean {
  return task.state === "stopped" && task.summary.includes("reaching its background time limit")
}

export function shellEndStatus(task: Task): string {
  const code = exitCode(task)
  if (task.state === "stopped") return ` was stopped${stoppedByTimeLimit(task) ? " (time limit)" : ""}`
  if (task.state === "failed") return code === null ? " failed" : ` failed with exit code ${code}`
  if (task.state === "completed") return code === null ? " completed" : ` completed (exit code ${code})`
  return " is running"
}

export function shellNodeId(taskId: string): string {
  return `shell:${taskId}`
}
