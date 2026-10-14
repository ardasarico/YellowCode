import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { initializeModels, initializeResponse, type ModelInfo, type SlashCommand } from "../protocol/messages.ts"
import { parse } from "../protocol/parse.ts"
import { initInfo } from "../session/session.ts"
import type { SessionInfo } from "../session/types.ts"

const headerSchema = z.object({ cliVersion: z.string(), scenario: z.string(), recordedAt: z.string() })
const entrySchema = z.object({ t: z.number(), dir: z.enum(["in", "out"]), line: z.string() })

export const SKILLS_DIALOG_ID = "record-skills-dialog"
export const SETTINGS_ID = "record-settings"

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

// Claude sends init only after the first user message, so the welcome screen takes it from the recording.
export function recordedInfo(recording: Recording): SessionInfo | null {
  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind === "message" && parsed.message.type === "system" && parsed.message.subtype === "init")
      return initInfo(parsed.message)
  }
  return null
}

export function recordedCommands(recording: Recording): SlashCommand[] {
  let rich: SlashCommand[] | null = null
  let init: { names: string[]; terminalOnly: string[] } | null = null

  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind !== "message") continue
    const message = parsed.message

    if (message.type === "control_response" && rich === null) {
      const response = initializeResponse.safeParse(message.response.response)
      if (response.success) rich = response.data.commands
    } else if (message.type === "system" && message.subtype === "init" && init === null) {
      init = { names: message.slash_commands ?? [], terminalOnly: message.terminal_slash_commands ?? [] }
    }
  }

  const commands = rich ?? (init?.names ?? []).map((name) => ({ name, description: "", argumentHint: "" }))
  const dropped = new Set(init?.terminalOnly)
  return commands.filter(({ name }) => !dropped.has(name) && name !== "help" && !name.startsWith("__"))
}

export function recordedModels(recording: Recording): ModelInfo[] {
  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind !== "message" || parsed.message.type !== "control_response") continue
    const response = initializeModels.safeParse(parsed.message.response.response)
    if (response.success) return response.data.models
  }
  return []
}
