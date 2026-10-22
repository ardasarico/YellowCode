import { z } from "zod"
import type { Agent } from "./types.ts"

const fields = z.looseObject({
  file_path: z.string().optional(),
  command: z.string().optional(),
  pattern: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
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

const agentFields = z.looseObject({
  name: z.string().optional(),
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
})

// A name is drawn on one row, so it keeps no escapes, line breaks or tabs.
const oneLine = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

export function agentOf(toolName: string, input: unknown): Agent | null {
  if (toolName !== "Agent") return null
  const parsed = agentFields.safeParse(input)
  if (!parsed.success) return null
  return {
    name: oneLine(parsed.data.name) || oneLine(parsed.data.subagent_type) || "agent",
    task: parsed.data.description ?? "",
    prompt: parsed.data.prompt ?? "",
    type: parsed.data.subagent_type ?? "",
    model: parsed.data.model ?? "",
    tokens: 0,
    state: "running",
    toolUses: 0,
    durationMs: 0,
    report: "",
    error: null,
    activity: "",
    stoppedByUser: false,
  }
}

const writeFields = z.looseObject({ content: z.string() })

export function writtenContent(input: unknown): string | null {
  const parsed = writeFields.safeParse(input)
  return parsed.success ? parsed.data.content : null
}

const messageFields = z.looseObject({ to: z.string().optional(), message: z.string().optional() })

export function sendMessageSummary(input: unknown, tasks: Record<string, { name: string } | undefined>): string {
  const parsed = messageFields.safeParse(input)
  if (!parsed.success || !parsed.data.to) return ""
  const to = parsed.data.to
  const line = oneLine((parsed.data.message ?? "").split("\n")[0])
  const summary = line ? `${tasks[to]?.name || to} · ${line}` : tasks[to]?.name || to
  return summary.length <= MAX_LENGTH ? summary : `${summary.slice(0, MAX_LENGTH - 1)}…`
}
