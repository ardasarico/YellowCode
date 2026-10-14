import type { Session, Task } from "./types.ts"

export function isShell(task: Task): boolean {
  return task.type === "local_bash" && task.background
}

// Running shells newest start first, then finished shells latest end first.
export function shellTasks(session: Session): Task[] {
  const shells = Object.values(session.tasks).filter(isShell)
  const running = shells
    .filter((task) => task.state === "running")
    .toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const ended = shells
    .filter((task) => task.state !== "running")
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...ended]
}

export function runningShellCount(session: Session): number {
  return Object.values(session.tasks).filter((task) => isShell(task) && task.state === "running").length
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

export function shellEndText(task: Task): string {
  const head = `Background command "${task.description || task.command}"`
  const code = exitCode(task)
  if (task.state === "stopped") return `${head} was stopped${stoppedByTimeLimit(task) ? " (time limit)" : ""}`
  if (task.state === "failed") return code === null ? `${head} failed` : `${head} failed with exit code ${code}`
  if (task.state === "completed") return code === null ? `${head} completed` : `${head} completed (exit code ${code})`
  return `${head} is running`
}

export function shellNodeId(taskId: string): string {
  return `shell:${taskId}`
}
