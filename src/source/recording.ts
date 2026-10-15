import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import {
  initializeModels,
  hooksListing,
  initializeResponse,
  type ModelInfo,
  pluginHook,
  type PluginHook,
  type SettingsSource,
  settingsSources,
  skillRow,
  type SkillRow,
  skillsDialog,
  type SlashCommand,
} from "../protocol/messages.ts"
import { parse } from "../protocol/parse.ts"
import { initInfo } from "../session/session.ts"
import type { SessionInfo } from "../session/types.ts"

const headerSchema = z.object({ cliVersion: z.string(), scenario: z.string(), recordedAt: z.string() })
const entrySchema = z.object({ t: z.number(), dir: z.enum(["in", "out"]), line: z.string() })

export const SKILLS_DIALOG_ID = "record-skills-dialog"
export const SETTINGS_ID = "record-settings"
export const HOOKS_ID = "record-hooks"

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

function recordedReply(recording: Recording, requestId: string) {
  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind !== "message" || parsed.message.type !== "control_response") continue
    if (parsed.message.response.request_id === requestId) return parsed.message.response
  }
  return null
}

export function recordedSkillRows(recording: Recording): {
  rows: SkillRow[]
  problem: string | null
  recorded: boolean
} {
  const reply = recordedReply(recording, SKILLS_DIALOG_ID)
  if (reply === null) return { rows: [], problem: null, recorded: false }
  if (reply.subtype !== "success")
    return { rows: [], problem: `${reply.subtype}: ${JSON.stringify(reply["error"])}`, recorded: true }

  const dialog = skillsDialog.safeParse(reply.response)
  if (!dialog.success) return { rows: [], problem: "no skills array", recorded: true }

  const rows: SkillRow[] = []
  for (const value of dialog.data.skills) {
    const row = skillRow.safeParse(value)
    if (row.success) rows.push(row.data)
  }
  const dropped = dialog.data.skills.length - rows.length
  return {
    rows,
    problem: dropped > 0 ? `dropped ${dropped} of ${dialog.data.skills.length} rows` : null,
    recorded: true,
  }
}

export function recordedSettingsSources(recording: Recording): SettingsSource[] {
  const reply = recordedReply(recording, SETTINGS_ID)
  const parsed = settingsSources.safeParse(reply?.response)
  return parsed.success ? parsed.data.sources : []
}

export function recordedPluginHooks(recording: Recording): PluginHook[] {
  const reply = recordedReply(recording, HOOKS_ID)
  const listing = hooksListing.safeParse(reply?.response)
  if (!listing.success) return []
  return listing.data.hooks.flatMap((value) => {
    const hook = pluginHook.safeParse(value)
    return hook.success ? [hook.data] : []
  })
}

export function recordedInitLists(recording: Recording): { skills: string[]; slashCommands: string[] } | null {
  for (const entry of recording.entries) {
    if (entry.dir !== "in") continue
    const parsed = parse(entry.line)
    if (parsed.kind === "message" && parsed.message.type === "system" && parsed.message.subtype === "init")
      return { skills: parsed.message.skills, slashCommands: parsed.message.slash_commands ?? [] }
  }
  return null
}
