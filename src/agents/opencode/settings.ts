// opencode's own settings in /settings, read from GET /api/config through the allowlist. Only the shell can be
// written: PATCH /experimental/config takes nothing else, and writes the global opencode.json.
import { isAbsolute, relative } from "node:path"
import { z } from "zod"
import type { Outcome } from "../../agent/ids.ts"
import type { SettingControl, SettingRow, SettingValue } from "../../agent/settings.ts"
import { log } from "../../log/log.ts"
import { configEntry, readAllowed, shellOption } from "./allow.ts"
import type { Transport } from "./transport.ts"
import { answerOf, rowsOf } from "./wire/envelope.ts"

type Info = NonNullable<z.output<typeof configEntry>["info"]>
type Document = { path: string | null; info: Info }

type Setting = {
  id: string
  label: string
  note: string | null
  control: SettingControl
  // Undefined: this document does not set it.
  read: (info: Info) => SettingValue | undefined
  // The value a writable row has when no document sets it.
  unset?: SettingValue
}

const toggle: SettingControl = { type: "toggle" }
const amount = (unit: string, min: number): SettingControl => ({ type: "number", min, max: null, step: 1, unit })

// "" stands for no shell of the config's own, which opencode then picks.
const OWN_SHELL = ""

const shell = (options: { value: string; label: string }[]): Setting => ({
  id: "shell",
  label: "Shell",
  note: null,
  control: { type: "choice", options: [{ value: OWN_SHELL, label: "default" }, ...options] },
  read: (info) => info.shell,
  unset: OWN_SHELL,
})

// Every other key of opencode's config is left out: providers and MCP servers hold keys, headers and environments;
// the model, default agent, plugins and skills are shown elsewhere; username is opencode's screen only; share,
// snapshots, instructions, agents, commands, LSP, formatters and experimental ones are not added. The keys still to
// be decided (owner question J) are left out too.
const READ_ONLY: Setting[] = [
  {
    id: "web-search",
    label: "Web search",
    note: "The search provider, or off",
    control: { type: "text" },
    read: (info) =>
      info.websearch === undefined ? undefined : info.websearch === false ? "off" : info.websearch.provider,
  },
  { id: "compaction.auto", label: "Auto-compact", note: null, control: toggle, read: (info) => info.compaction?.auto },
  {
    id: "compaction.threshold",
    label: "Compaction buffer",
    note: "Tokens left free before compaction starts",
    control: amount("tokens", 0),
    read: (info) => info.compaction?.buffer,
  },
  {
    id: "compaction.keep",
    label: "Kept after compaction",
    note: "Recent tokens compaction keeps as they are",
    control: amount("tokens", 0),
    read: (info) => info.compaction?.keep?.tokens,
  },
  {
    id: "tool-output.lines",
    label: "Tool output lines",
    note: null,
    control: amount("lines", 1),
    read: (info) => info.tool_output?.max_lines,
  },
  {
    id: "tool-output.bytes",
    label: "Tool output size",
    note: null,
    control: amount("bytes", 1),
    read: (info) => info.tool_output?.max_bytes,
  },
  {
    id: "images.resize",
    label: "Resize images",
    note: null,
    control: toggle,
    read: (info) => info.media?.image?.auto_resize,
  },
  {
    id: "images.width",
    label: "Image max width",
    note: null,
    control: amount("px", 1),
    read: (info) => info.media?.image?.max_width,
  },
  {
    id: "images.height",
    label: "Image max height",
    note: null,
    control: amount("px", 1),
    read: (info) => info.media?.image?.max_height,
  },
  {
    id: "images.size",
    label: "Image max size",
    note: null,
    control: amount("bytes", 1),
    read: (info) => info.media?.image?.max_base64_bytes,
  },
]

// A document inside the project's folder is the project's; any other is the user's. The project's folder is the
// repository's root for a session in a subfolder.
export const inFolder = (path: string, folder: string) => {
  const inside = relative(folder, path)
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
}

const layerOf = (path: string, project: string) => (inFolder(path, project) ? "project" : "user")

const located = z.looseObject({ project: z.looseObject({ directory: z.string() }) })

// The project's folder; the session's own when opencode does not say.
export async function projectFolder(transport: Transport, directory: string): Promise<string> {
  const reply = await transport.request({ method: "GET", path: "/api/location" }).catch(() => null)
  const answer = reply ? answerOf(reply, located, "location") : null
  return answer?.kind === "ok" ? answer.value.project.directory : directory
}

// Each row has the value of the last document that sets it (opencode lists them lowest first) and that file; a key
// no document sets has opencode's own default, which /api/config does not say, so its value and origin are null.
function rowOf(setting: Setting, documents: Document[], project: string, writable: boolean): SettingRow {
  const winner = documents.findLast((document) => setting.read(document.info) !== undefined)
  const layer = winner?.path ? layerOf(winner.path, project) : null
  return {
    id: setting.id,
    label: setting.label,
    section: "",
    note: setting.note,
    control: setting.control,
    value: winner ? (setting.read(winner.info) ?? null) : (setting.unset ?? null),
    writable,
    applies: "now",
    origin: winner?.path && layer ? { file: winner.path, layer } : null,
    // A write goes to the user's file, which the project's wins over.
    overriddenBy: writable && layer === "project" ? "project" : null,
  }
}

// Two shells of one name are told apart by their paths.
function shellChoices(listed: z.output<typeof shellOption>[]) {
  const usable = listed.filter((option) => option.acceptable)
  return usable.map((option) => ({
    value: option.path,
    label: usable.filter((other) => other.name === option.name).length > 1 ? option.path : option.name,
  }))
}

// Null when opencode did not give its config.
export async function settingRows(transport: Transport, directory: string): Promise<SettingRow[] | null> {
  const entries = await readAllowed(transport, "/api/config", "the config")
  if (!Array.isArray(entries)) return null
  const documents = rowsOf(entries, configEntry, "config entry").flatMap((entry): Document[] =>
    entry.type === "document" && entry.info ? [{ path: entry.path ?? null, info: entry.info }] : [],
  )
  const shells = await readAllowed(transport, "/api/config/shell", "the shells")
  const choices = shellChoices(Array.isArray(shells) ? rowsOf(shells, shellOption, "shell") : [])
  const project = await projectFolder(transport, directory)
  return [
    rowOf(shell(choices), documents, project, true),
    ...READ_ONLY.map((setting) => rowOf(setting, documents, project, false)),
  ]
}

// Only the shell; "" leaves the pick to opencode.
export async function writeSetting(transport: Transport, id: string, value: SettingValue): Promise<Outcome> {
  const setting = READ_ONLY.find((row) => row.id === id)
  if (id !== "shell" || typeof value !== "string")
    return { ok: false, problem: setting ? `${setting.label} cannot be changed here` : `opencode has no setting ${id}` }
  const path = "/api/experimental/config"
  const reply = await transport
    .request({ method: "PATCH", path, body: { shell: value === OWN_SHELL ? null : value } })
    .catch(() => null)
  const answer = reply ? answerOf(reply, z.unknown(), "config") : null
  if (answer?.kind === "ok") return { ok: true, note: null }
  const problem = answer?.kind === "error" && answer.message ? answer.message : "opencode did not take the shell"
  log.warn("opencode: the shell was not written", problem)
  return { ok: false, problem }
}
