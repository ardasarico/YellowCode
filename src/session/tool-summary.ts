import type { Task, ToolCall } from "./types.ts"

// The longest one-line summary a row gets.
export const SUMMARY_LENGTH = 120

// A name is drawn on one row, so it keeps no escapes, line breaks or tabs.
export const oneLine = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

// A message to a subagent, named after it.
export function messageSummary(to: string, text: string, tasks: Record<string, { name: string } | undefined>): string {
  const line = oneLine(text.split("\n")[0])
  const summary = line ? `${tasks[to]?.name || to} · ${line}` : tasks[to]?.name || to
  return summary.length <= SUMMARY_LENGTH ? summary : `${summary.slice(0, SUMMARY_LENGTH - 1)}…`
}

// The agent starts a shell in the background, or the user sends a running one there with Ctrl+B.
export function isBackgroundShell(tool: ToolCall, task: Pick<Task, "background"> | null): boolean {
  return tool.toolKind === "shell" && tool.taskId !== null && (tool.background || task?.background === true)
}
