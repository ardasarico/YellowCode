// opencode's own settings in /settings, read from GET /api/config through the allowlist. Only the shell can be
// written: PATCH /experimental/config takes nothing else, and writes the global opencode.json.
import { isAbsolute, relative } from "node:path"
import { z } from "zod"
import type { Outcome } from "../../agent/ids.ts"
import type { RuleRow } from "../../agent/lists.ts"
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
  // opencode adds up every document's list instead of taking the last one.
  combined?: true
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

const ruleList = (rules: { action: string; resource: string; effect: string }[] | undefined) =>
  rules?.map((rule) => `${rule.effect} ${rule.action} ${rule.resource}`).join(", ")

// Every other key of opencode's config is left out: providers and MCP servers hold keys, headers and environments;
// the model, default agent, permissions, plugins and skills are shown elsewhere; username is opencode's screen only;
// update, enterprise, share, snapshots, instructions, references, agents, commands, LSP, formatters and experimental
// ones are not added.
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
  {
    id: "policies",
    label: "Policies",
    note: "Providers, tools and integrations allowed or denied",
    control: { type: "text" },
    read: (info) => ruleList(info.policies),
    combined: true,
  },
  {
    id: "watcher.ignore",
    label: "Watcher ignores",
    note: "Files the file watcher skips",
    control: { type: "text" },
    read: (info) => info.watcher?.ignore?.join(", "),
    combined: true,
  },
  {
    id: "worktree.directory",
    label: "Worktree folder",
    note: "Where new worktrees go",
    control: { type: "text" },
    read: (info) => info.worktree?.directory,
  },
  {
    id: "warming",
    label: "Cache warming",
    note: "Keeps the prompt cache warm between requests",
    control: toggle,
    read: (info) => (typeof info.warming === "object" ? true : info.warming),
  },
  {
    id: "warming.interval",
    label: "Warming interval",
    note: "Idle time between keep-alive requests",
    control: { type: "text" },
    read: (info) => (typeof info.warming === "object" ? info.warming.interval : undefined),
  },
  {
    id: "warming.duration",
    label: "Warming duration",
    note: "How long a session stays warm after its last request",
    control: { type: "text" },
    read: (info) => (typeof info.warming === "object" ? info.warming.duration : undefined),
  },
  {
    id: "mcp.startup",
    label: "MCP startup timeout",
    note: null,
    control: amount("ms", 1),
    read: (info) => info.mcp?.timeout?.startup,
  },
  {
    id: "mcp.catalog",
    label: "MCP catalog timeout",
    note: "Listing a server's tools and prompts",
    control: amount("ms", 1),
    read: (info) => info.mcp?.timeout?.catalog,
  },
  {
    id: "mcp.execution",
    label: "MCP call timeout",
    note: null,
    control: amount("ms", 1),
    read: (info) => info.mcp?.timeout?.execution,
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
// A combined row lists every document's values, highest first as opencode weighs policies.
function rowOf(setting: Setting, documents: Document[], project: string, writable: boolean): SettingRow {
  const setters = documents.filter((document) => setting.read(document.info) !== undefined)
  const winner = setters.at(-1)
  const value = setting.combined
    ? setters
        .toReversed()
        .map((document) => setting.read(document.info))
        .filter((part) => part !== "")
        .join(", ")
    : winner && setting.read(winner.info)
  const layer = winner?.path ? layerOf(winner.path, project) : null
  return {
    id: setting.id,
    label: setting.label,
    section: "",
    note: setting.note,
    control: setting.control,
    value: winner ? (value ?? null) : (setting.unset ?? null),
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

async function readDocuments(transport: Transport): Promise<Document[] | null> {
  const entries = await readAllowed(transport, "/api/config", "the config")
  if (!Array.isArray(entries)) return null
  return rowsOf(entries, configEntry, "config entry").flatMap((entry): Document[] =>
    entry.type === "document" && entry.info ? [{ path: entry.path ?? null, info: entry.info }] : [],
  )
}

const EFFECTS = new Set<string>(["allow", "ask", "deny"] satisfies RuleRow["effect"][])
const isEffect = (effect: string): effect is RuleRow["effect"] => EFFECTS.has(effect)

// The rules written in the config files, lowest first as opencode reads them; they are changed in the files only.
export async function configRules(transport: Transport, directory: string): Promise<RuleRow[] | null> {
  const documents = await readDocuments(transport)
  if (documents === null) return null
  if (!documents.some((document) => document.info.permissions?.length)) return []
  const project = await projectFolder(transport, directory)
  return documents.flatMap(({ path, info }, position) =>
    (info.permissions ?? []).flatMap((rule, index): RuleRow[] =>
      isEffect(rule.effect)
        ? [
            {
              id: `config:${path ?? position}:${index}`,
              subject: rule.action,
              pattern: rule.resource,
              effect: rule.effect,
              lasts: path && layerOf(path, project) === "project" ? "project" : "everywhere",
              origin: path,
              mode: null,
              removable: false,
            },
          ]
        : [],
    ),
  )
}

// Null when opencode did not give its config.
export async function settingRows(transport: Transport, directory: string): Promise<SettingRow[] | null> {
  const documents = await readDocuments(transport)
  if (documents === null) return null
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
