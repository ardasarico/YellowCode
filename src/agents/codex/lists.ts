// The lists Codex keeps for a session's folder: skills, plugins, hooks, MCP servers, commands and files.
/* oxlint-disable no-await-in-loop -- each page names the next */
import { isAbsolute, relative } from "node:path"
import type { CommandRow, HookRow, McpServerRow, McpState, PluginRow, SkillRow } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import type { Rpc } from "./transport.ts"
import {
  fileMatches,
  hooksList,
  mcpStatusPage,
  pluginsInstalled,
  skillsList,
  type CodexMcpServer,
} from "./wire/lists.ts"
import { resultOf } from "./wire/thread.ts"

// Codex has no command list of its own; these are the ones YellowCode runs through its requests. Skills join them.
export const CODEX_COMMANDS: CommandRow[] = [
  {
    name: "compact",
    description: "Summarize the conversation to free up context",
    argumentHint: "",
    aliases: [],
    builtin: true,
    setting: null,
    knob: null,
  },
]

const inFolder = (path: string, folder: string) => {
  const inside = relative(folder, path)
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
}

const GROUPS: Record<string, SkillRow["group"]> = {
  system: "builtin",
  user: "global",
  admin: "global",
  repo: "project",
}

// A skill's id is its SKILL.md, which Codex toggles it by and a prompt names it with.
export async function readSkills(rpc: Rpc, cwd: string, forceReload = false): Promise<SkillRow[] | null> {
  const reply = resultOf(
    await rpc.request("skills/list", { cwds: [cwd], ...(forceReload ? { forceReload } : {}) }).catch(() => null),
    skillsList,
    "skills/list",
  )
  if (reply.kind !== "ok") return null
  return reply.value.data.flatMap((entry) =>
    entry.skills.map((skill) => ({
      id: skill.path,
      name: skill.name,
      label: skill.interface?.displayName ?? skill.name,
      description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
      command: skill.name,
      group: GROUPS[skill.scope] ?? "global",
      plugin: skill.pluginId ?? null,
      enabled: skill.enabled,
      // An admin's skill is the policy's to turn off.
      locked: skill.scope === "admin",
    })),
  )
}

// Ours, then each skill that is on, as `/name`; a skill named like one of ours is left to the skills dialog.
export const commandRows = (skills: SkillRow[]): CommandRow[] => [
  ...CODEX_COMMANDS,
  ...skills
    .filter((skill) => skill.enabled && !CODEX_COMMANDS.some((command) => command.name === skill.name))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      argumentHint: "",
      aliases: [],
      builtin: false,
      setting: null,
      knob: null,
    })),
]

// Codex says which plugins brought a skill, a hook or a server, but not in this list, so `brings` stays empty.
export async function readPlugins(rpc: Rpc, cwd: string): Promise<PluginRow[] | null> {
  const reply = resultOf(
    await rpc.request("plugin/installed", { cwds: [cwd] }).catch(() => null),
    pluginsInstalled,
    "plugin/installed",
  )
  if (reply.kind !== "ok") return null
  return reply.value.marketplaces.flatMap((marketplace) =>
    marketplace.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.interface?.displayName ?? plugin.name,
        marketplace: marketplace.name,
        scope: marketplace.path && inFolder(marketplace.path, cwd) ? ("project" as const) : ("global" as const),
        on: plugin.enabled,
        brings: { skills: [], mcp: [], commands: [], agents: [], hooks: [] },
      })),
  )
}

// A hook's command is not kept.
export async function readHooks(rpc: Rpc, cwd: string): Promise<HookRow[] | null> {
  const reply = resultOf(await rpc.request("hooks/list", { cwds: [cwd] }).catch(() => null), hooksList, "hooks/list")
  if (reply.kind !== "ok") return null
  return reply.value.data.flatMap((entry) =>
    entry.hooks.map((hook) => ({
      event: hook.eventName.charAt(0).toUpperCase() + hook.eventName.slice(1),
      matcher: hook.matcher ?? "",
      plugin: hook.pluginId ?? null,
    })),
  )
}

const RUNTIME: Record<string, McpState> = {
  connected: "connected",
  starting: "connecting",
  authenticationRequired: "needs-login",
  failed: "failed",
  cancelled: "failed",
  disabled: "off",
}

// mcpServer/startupStatus/updated's words.
export const STARTUP: Record<string, McpState> = {
  starting: "connecting",
  ready: "connected",
  failed: "failed",
  cancelled: "failed",
}

function stateOf(server: CodexMcpServer): { state: McpState; status: string } {
  if (server.runtimeStatus) return { state: RUNTIME[server.runtimeStatus] ?? "unknown", status: server.runtimeStatus }
  if (server.toolsError) return { state: "failed", status: "failed" }
  return { state: server.authStatus === "notLoggedIn" ? "needs-login" : "unknown", status: server.authStatus }
}

// A failed server's error can quote its command line, so it is not kept.
const rowOf = (server: CodexMcpServer): McpServerRow => ({
  name: server.name,
  label: server.name,
  place: "other",
  ...stateOf(server),
  origin: server.pluginId ? `plugin ${server.pluginId}` : null,
  scope: null,
  error: null,
  config: server.httpOrigin ? { url: server.httpOrigin } : null,
  server: server.serverInfo ? { name: server.serverInfo.name, version: server.serverInfo.version } : null,
  tools: Object.keys(server.tools),
  toolServer: server.name,
})

const MAX_PAGES = 20

// The servers as the thread has them.
export async function readMcp(rpc: Rpc, thread: string): Promise<McpServerRow[] | null> {
  const rows: McpServerRow[] = []
  let cursor: string | null = null
  for (let count = 0; count < MAX_PAGES; count++) {
    const params = { threadId: thread, detail: "toolsAndAuthOnly", ...(cursor === null ? {} : { cursor }) }
    const listed: unknown = await rpc.request("mcpServerStatus/list", params).catch(() => null)
    const reply = resultOf(listed, mcpStatusPage, "mcpServerStatus/list")
    if (reply.kind !== "ok") return null
    rows.push(...reply.value.data.map(rowOf))
    cursor = reply.value.nextCursor ?? null
    if (cursor === null) break
  }
  return rows
}

const FILE_ROWS = 15

// Paths in the session's folder, folders with a slash at the end; git's own folder is left out.
export async function findFiles(rpc: Rpc, cwd: string, query: string): Promise<string[]> {
  const reply = resultOf(
    await rpc.request("fuzzyFileSearch", { query, roots: [cwd], cancellationToken: null }).catch(() => null),
    fileMatches,
    "fuzzyFileSearch",
  )
  if (reply.kind !== "ok") {
    log.debug("codex: no file suggestions")
    return []
  }
  return reply.value.files
    .filter((file) => file.path !== ".git" && !file.path.startsWith(".git/"))
    .map((file) => (file.match_type === "directory" ? `${file.path}/` : file.path))
    .slice(0, FILE_ROWS)
}
