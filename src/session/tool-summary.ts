import { z } from "zod"
import type { Task, ToolCall } from "./types.ts"

const fields = z.looseObject({
  file_path: z.string().optional(),
  command: z.string().optional(),
  pattern: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  skill: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  questions: z.array(z.looseObject({ header: z.string().optional() })).optional(),
  matrix: z.looseObject({ header: z.string().optional() }).optional(),
})

const MAX_LENGTH = 120

export function summarizeToolInput(input: unknown): string {
  const parsed = fields.safeParse(input)
  if (!parsed.success) return ""
  const f = parsed.data
  const headers = f.questions?.flatMap((question) => question.header ?? []).join(", ")
  const value =
    f.file_path ??
    f.command ??
    f.pattern ??
    f.path ??
    f.url ??
    f.query ??
    f.skill ??
    f.description ??
    f.prompt ??
    (headers || undefined) ??
    f.matrix?.header ??
    ""
  const line = Bun.stripANSI(value).split("\n")[0] ?? ""
  // A path stays whole: the row cuts it from the start, so the file name stays.
  if (line.length <= MAX_LENGTH || value === f.file_path || value === f.path) return line
  return `${line.slice(0, MAX_LENGTH - 1)}…`
}

// A name is drawn on one row, so it keeps no escapes, line breaks or tabs.
export const oneLine = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

const writeFields = z.looseObject({ content: z.string() })

export function writtenContent(input: unknown): string | null {
  const parsed = writeFields.safeParse(input)
  return parsed.success ? parsed.data.content : null
}

// A message to a subagent, named after it.
export function messageSummary(to: string, text: string, tasks: Record<string, { name: string } | undefined>): string {
  const line = oneLine(text.split("\n")[0])
  const summary = line ? `${tasks[to]?.name || to} · ${line}` : tasks[to]?.name || to
  return summary.length <= MAX_LENGTH ? summary : `${summary.slice(0, MAX_LENGTH - 1)}…`
}

// Claude starts a shell in the background, or the user sends a running one there with Ctrl+B.
export function isBackgroundShell(tool: ToolCall, task: Pick<Task, "background"> | null): boolean {
  const input = tool.input
  const asked = typeof input === "object" && input !== null && "run_in_background" in input
  const background = (asked && input.run_in_background === true) || task?.background === true
  return tool.name === "Bash" && tool.taskId !== null && background
}
