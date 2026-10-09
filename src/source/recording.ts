import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { parse } from "../protocol/parse.ts"

const headerSchema = z.object({ cliVersion: z.string(), scenario: z.string(), recordedAt: z.string() })
const entrySchema = z.object({ t: z.number(), dir: z.enum(["in", "out"]), line: z.string() })

export type RecordingHeader = z.infer<typeof headerSchema>
export type RecordingEntry = z.infer<typeof entrySchema>
export type Recording = { header: RecordingHeader; entries: RecordingEntry[] }

export class RecordingError extends Error {}

export function parseRecording(text: string): Recording {
  let header: RecordingHeader | null = null
  const entries: RecordingEntry[] = []

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue
    const json = parseJson(line)
    if (!json.ok) throw new RecordingError(`line ${index + 1}: ${json.error}`)

    const schema = header === null ? headerSchema : entrySchema
    const parsed = schema.safeParse(json.value)
    if (!parsed.success) throw new RecordingError(`line ${index + 1}: ${z.prettifyError(parsed.error)}`)

    if (header === null) header = headerSchema.parse(parsed.data)
    else entries.push(entrySchema.parse(parsed.data))
  }

  if (header === null) throw new RecordingError("recording is empty")
  return { header, entries }
}

export async function loadRecording(path: string): Promise<Recording> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new RecordingError(`recording not found: ${path}`)
  return parseRecording(await file.text())
}

export function serializeRecording(recording: Recording): string {
  return [recording.header, ...recording.entries].map((value) => JSON.stringify(value)).join("\n") + "\n"
}

export function recordedModel(recording: Recording): string | null {
  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind === "message" && parsed.message.type === "system" && parsed.message.subtype === "init")
      return parsed.message.model
  }
  return null
}
