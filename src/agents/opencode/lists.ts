// The lists opencode keeps for a session's project.
import { basename, extname } from "node:path"
import { z } from "zod"
import type {
  CommandRow,
  EffortRow,
  McpServerRow,
  McpState,
  ModelGroup,
  ModelRow,
  PluginRow,
  RuleRow,
  SkillRow,
} from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { mcpServer, model, pluginInfo, provider, readAllowed, skillInfo } from "./allow.ts"
import { configRules, inFolder } from "./settings.ts"
import type { Transport } from "./transport.ts"
import { answerOf, dataOf, rowsOf } from "./wire/envelope.ts"

const saved = z.looseObject({ id: z.string(), action: z.string(), resource: z.string() })
const located = z.looseObject({ project: z.looseObject({ id: z.string() }) })

// The project opencode keeps for the folder, which "always" saves under. It can differ from the session's projectID:
// a folder opened before its first commit keeps the id it had then.
async function folderProject(transport: Transport, directory: string): Promise<string | null> {
  const query = { "location[directory]": directory }
  const reply = await transport.request({ method: "GET", path: "/api/location", query }).catch(() => null)
  const answer = reply ? answerOf(reply, located, "location") : null
  return answer?.kind === "ok" ? answer.value.project.id : null
}

// What "always" saved for the session's folder, each removable, then the config files' rules. Null when opencode did
// not answer.
export async function savedRules(transport: Transport, directory: string): Promise<RuleRow[] | null> {
  const path = "/api/permission/saved"
  const project = await folderProject(transport, directory)
  const reply =
    project === null
      ? null
      : await transport.request({ method: "GET", path, query: { projectID: project } }).catch(() => null)
  const answer = reply ? answerOf(reply, dataOf(z.array(z.unknown())), path) : null
  if (answer?.kind !== "ok") {
    log.warn(
      `opencode: could not read the saved permissions (${answer?.kind === "error" ? answer.status : "no answer"})`,
    )
    return null
  }
  const written = await configRules(transport, directory)
  const rows = rowsOf(answer.value.data, saved, "saved permission").map((rule): RuleRow => ({
    id: rule.id,
    subject: rule.action,
    pattern: rule.resource,
    effect: "allow",
    lasts: "project",
    origin: null,
    mode: null,
    removable: true,
  }))
  return [...rows, ...(written ?? [])]
}

// opencode's name for a model's own settings, which the session has while no variant is picked.
export const DEFAULT_VARIANT = "default"

type Listed = z.output<typeof model>

// The default comes first, then the model's variants; a model without variants has no levels.
function effortsOf(listed: Listed): EffortRow[] {
  const variants = (listed.variants ?? []).filter((variant) => variant.id !== DEFAULT_VARIANT)
  if (variants.length === 0) return []
  return [DEFAULT_VARIANT, ...variants.map((variant) => variant.id)].map((id) => ({ id, label: id }))
}

const rowOf = (listed: Listed): ModelRow => ({
  ref: { provider: listed.providerID, id: listed.id },
  label: listed.name,
  note: "",
  resolves: null,
  efforts: effortsOf(listed),
  images: listed.capabilities?.input.includes("image") ?? false,
  window: listed.limit?.context ?? null,
})

// One group per provider, in opencode's order, each with its models in opencode's order. A switch to another
// provider's model takes effect in the running session. Null when opencode did not list its models.
export async function readModels(transport: Transport): Promise<ModelGroup[] | null> {
  const models = await readAllowed(transport, "/api/model", "the models")
  if (!Array.isArray(models)) return null
  const providers = await readAllowed(transport, "/api/provider", "the providers")
  const listed = rowsOf(models, model, "model").filter((row) => row.enabled !== false)
  const named = Array.isArray(providers) ? rowsOf(providers, provider, "provider") : []
  const ids = [...new Set([...named.map((row) => row.id), ...listed.map((row) => row.providerID)])]
  return ids.flatMap((id): ModelGroup[] => {
    const rows = listed.filter((row) => row.providerID === id).map(rowOf)
    if (rows.length === 0) return []
    const name = named.find((row) => row.id === id)?.name ?? id
    return [{ provider: { id, name }, applies: "now", models: rows }]
  })
}

const STATES = new Map<string, McpState>(
  Object.entries({
    connected: "connected",
    pending: "connecting",
    disabled: "off",
    failed: "failed",
    needs_auth: "needs-login",
  }),
)

// opencode says neither where a server is set up nor which tools it has. Its MCP tools show only inside `execute`
// (Code Mode), so no call names a server.
// The names of the folder's own servers before YellowCode handed any, and of those it handed.
export type SharedMarks = { own: ReadonlySet<string>; handed: ReadonlySet<string> }

// A server YellowCode handed has the scope "shared"; its origin says when it stands in for one of opencode's own.
const originOf = (name: string, marks: SharedMarks | undefined) =>
  !marks?.handed.has(name) ? null : marks.own.has(name) ? "shared, over opencode's own" : "shared"

export async function readMcp(transport: Transport, marks?: SharedMarks): Promise<McpServerRow[] | null> {
  const rows = await readAllowed(transport, "/api/mcp", "the MCP servers")
  if (!Array.isArray(rows)) return null
  return rowsOf(rows, mcpServer, "MCP server").map((row) => ({
    name: row.name,
    label: row.title ?? row.name,
    place: "other",
    state: STATES.get(row.status.status) ?? "unknown",
    status: row.status.status,
    origin: originOf(row.name, marks),
    scope: marks?.handed.has(row.name) ? "shared" : null,
    error: null,
    config: null,
    server: null,
    tools: null,
    toolServer: row.name,
  }))
}

// opencode's own skills have a `/builtin/` path; the rest are the project's when they are in its folder.
export async function readSkills(transport: Transport, project: string): Promise<SkillRow[] | null> {
  const rows = await readAllowed(transport, "/api/skill", "the skills")
  if (!Array.isArray(rows)) return null
  return rowsOf(rows, skillInfo, "skill").map((row) => ({
    id: row.id,
    name: row.name,
    label: row.name,
    description: row.description ?? "",
    command: null,
    group: row.path.startsWith("/builtin/") ? "builtin" : inFolder(row.path, project) ? "project" : "global",
    plugin: null,
    enabled: true,
    locked: false,
  }))
}

const command = z.looseObject({ name: z.string(), description: z.string().optional() })

// opencode lists no /compact; YellowCode runs it through the session's compact request.
export const COMPACT: CommandRow = {
  name: "compact",
  description: "Summarize the conversation to free up context",
  argumentHint: "",
  aliases: [],
  builtin: true,
  setting: null,
  knob: null,
}

// opencode does not say which commands are its own. /compact is always the session's summary, as in opencode's TUI.
export async function readCommands(transport: Transport): Promise<CommandRow[] | null> {
  const path = "/api/command"
  const reply = await transport.request({ method: "GET", path }).catch(() => null)
  const answer = reply ? answerOf(reply, dataOf(z.array(z.unknown())), path) : null
  if (answer?.kind !== "ok") {
    log.warn(`opencode: could not read the commands (${answer?.kind === "error" ? answer.status : "no answer"})`)
    return null
  }
  const rows = rowsOf(answer.value.data, command, "command").map((row) => ({
    name: row.name,
    description: row.description ?? "",
    argumentHint: "",
    aliases: [],
    builtin: false,
    setting: null,
    knob: null,
  }))
  return [...rows.filter((row) => row.name !== COMPACT.name), COMPACT]
}

type Plugin = z.output<typeof pluginInfo>

const pluginName = ({ id, source }: Plugin) =>
  id ?? source.target ?? (source.path ? basename(source.path, extname(source.path)) : source.type)

// opencode's own plugins are left out. A plugin that failed to load reads as off.
export async function readPlugins(transport: Transport, project: string): Promise<PluginRow[] | null> {
  const rows = await readAllowed(transport, "/api/plugin", "the plugins")
  if (!Array.isArray(rows)) return null
  return rowsOf(rows, pluginInfo, "plugin")
    .filter((row) => row.source.type !== "builtin")
    .map((row) => ({
      id: row.id ?? row.source.path ?? row.source.target ?? row.source.type,
      name: pluginName(row),
      marketplace: null,
      scope: row.source.path && inFolder(row.source.path, project) ? "project" : "global",
      on: row.state.status === "active",
      brings: { skills: [], mcp: [], commands: [], agents: [], hooks: [] },
    }))
}

const FILE_ROWS = 15
const entry = z.looseObject({ path: z.string() })

// Paths in the session's folder, folders with a slash at the end. opencode lists the folder itself as "/"; it is
// left out, as a queried folder is, so two more are asked for.
export async function findFiles(transport: Transport, query: string): Promise<string[]> {
  const path = "/api/fs/find"
  const reply = await transport
    .request({ method: "GET", path, query: { query, limit: String(FILE_ROWS + 2) } })
    .catch(() => null)
  const answer = reply ? answerOf(reply, dataOf(z.array(z.unknown())), path) : null
  if (answer?.kind !== "ok") {
    log.debug(`opencode: no file suggestions (${answer?.kind === "error" ? answer.status : "no answer"})`)
    return []
  }
  return rowsOf(answer.value.data, entry, "file")
    .map((row) => row.path)
    .filter((found) => found !== "/" && !(found === query && query.endsWith("/")))
    .slice(0, FILE_ROWS)
}
