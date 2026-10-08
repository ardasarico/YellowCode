import { z } from "zod"

const fields = z.looseObject({
  file_path: z.string().optional(),
  command: z.string().optional(),
  pattern: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
})

const MAX_LENGTH = 120

export function summarizeToolInput(input: unknown): string {
  const parsed = fields.safeParse(input)
  if (!parsed.success) return ""
  const f = parsed.data
  const value = f.file_path ?? f.command ?? f.pattern ?? f.path ?? f.url ?? f.query ?? f.description ?? f.prompt ?? ""
  const line = value.split("\n")[0] ?? ""
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line
}

const agentFields = z.looseObject({
  name: z.string().optional(),
  subagent_type: z.string().optional(),
  description: z.string().optional(),
})

export function agentOf(toolName: string, input: unknown): { name: string; task: string } | null {
  if (toolName !== "Agent") return null
  const parsed = agentFields.safeParse(input)
  if (!parsed.success) return null
  return { name: parsed.data.name ?? parsed.data.subagent_type ?? "agent", task: parsed.data.description ?? "" }
}

const writeFields = z.looseObject({ content: z.string() })

export function writtenContent(input: unknown): string | null {
  const parsed = writeFields.safeParse(input)
  return parsed.success ? parsed.data.content : null
}
