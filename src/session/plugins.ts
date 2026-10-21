import type { PluginHook, SettingsSource, SkillRow } from "../protocol/messages.ts"
import { pluginGroup } from "./skills.ts"
import type { SessionInfo } from "./types.ts"

export type Plugin = {
  name: string
  marketplace: string | null
  scope: "global" | "project"
  on: boolean
  brings: { skills: string[]; mcp: string[]; commands: string[]; agents: string[]; hooks: string[] }
}

const PROJECT_SOURCES = new Set(["projectSettings", "localSettings"])
// The setting sources `claude plugin enable|disable --scope` writes.
const CLI_SCOPES: Record<string, "user" | "project" | "local"> = {
  userSettings: "user",
  projectSettings: "project",
  localSettings: "local",
}

// How settings and claude's CLI name a plugin.
export const pluginSettingId = (plugin: Plugin) =>
  plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name

// Where the setting that decides a plugin's state lives: the last source that names it. Null when no source does (a
// --plugin-dir, synced or skills-dir plugin) or when the CLI cannot write that source (flag, policy).
export function pluginScope(plugin: Plugin, sources: SettingsSource[]): "user" | "project" | "local" | null {
  const id = pluginSettingId(plugin)
  let scope: "user" | "project" | "local" | null = null
  for (const { source, settings } of sources)
    if (Object.hasOwn(settings.enabledPlugins ?? {}, id)) scope = CLI_SCOPES[source] ?? null
  return scope
}

const owned = (names: string[], prefix: string) =>
  names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length))

// Off plugins are not in init; they are the enabledPlugins ids whose last setting source turns them off.
function offPlugins(sources: SettingsSource[], on: Set<string>): Plugin[] {
  const last = new Map<string, { value: unknown; source: string }>()
  for (const { source, settings } of sources)
    for (const [id, value] of Object.entries(settings.enabledPlugins ?? {})) last.set(id, { value, source })

  return [...last].flatMap(([id, { value, source }]) => {
    const [name = id, marketplace = null] = id.split("@")
    if (value !== false || on.has(name)) return []
    const scope = PROJECT_SOURCES.has(source) ? "project" : "global"
    return [
      { name, marketplace, scope, on: false, brings: { skills: [], mcp: [], commands: [], agents: [], hooks: [] } },
    ]
  })
}

export function pluginEntries(
  info: SessionInfo,
  sources: SettingsSource[],
  skillRows: SkillRow[],
  hooks: PluginHook[],
): Plugin[] {
  const pluginSkills = skillRows.filter((row) => row.source === "plugin").map((row) => row.name)
  const commands = info.slashCommands.filter((name) => !info.skills.includes(name))
  const servers = info.mcpServers.filter((server) => server.source === "plugin").map((server) => server.name)

  const on = info.plugins.map(({ name, source }): Plugin => {
    const ownHooks = hooks
      .filter((hook) => hook.pluginName === source || hook.pluginName === name)
      .map(({ event, matcher }) => (matcher === "" ? event : `${event} ${matcher}`))
    return {
      name,
      marketplace: source?.split("@")[1] ?? null,
      scope: pluginGroup(name, sources),
      on: true,
      brings: {
        skills: owned(pluginSkills, `${name}:`),
        mcp: owned(servers, `plugin:${name}:`),
        commands: owned(commands, `${name}:`),
        agents: owned(info.agents, `${name}:`),
        hooks: [...new Set(ownHooks)],
      },
    }
  })
  const off = offPlugins(sources, new Set(on.map(({ name }) => name)))
  return [...on, ...off]
    .filter((plugin) => plugin.marketplace !== "builtin")
    .toSorted((a, b) => a.name.localeCompare(b.name) || (a.marketplace ?? "").localeCompare(b.marketplace ?? ""))
}
