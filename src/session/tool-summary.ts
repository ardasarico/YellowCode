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
