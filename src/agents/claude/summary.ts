import { z } from "zod"
import { SUMMARY_LENGTH } from "../../session/tool-summary.ts"

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
  if (line.length <= SUMMARY_LENGTH || value === f.file_path || value === f.path) return line
  return `${line.slice(0, SUMMARY_LENGTH - 1)}…`
}

const writeFields = z.looseObject({ content: z.string() })

export function writtenContent(input: unknown): string | null {
  const parsed = writeFields.safeParse(input)
  return parsed.success ? parsed.data.content : null
}
