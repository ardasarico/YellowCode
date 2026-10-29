import type { PluginRow } from "../../agent/lists.ts"
import type { PluginHook, SettingsSource, SkillRow } from "../../protocol/messages.ts"
import type { SessionInfo } from "../../session/types.ts"
import { PROJECT_SCOPES, pluginGroup } from "./skills.ts"

// The setting sources `claude plugin enable|disable --scope` writes.
const CLI_SCOPES: Record<string, "user" | "project" | "local"> = {
  userSettings: "user",
  projectSettings: "project",
  localSettings: "local",
}

// How settings and claude's CLI name a plugin.
const settingId = (name: string, marketplace: string | null) => (marketplace ? `${name}@${marketplace}` : name)

// Where the setting that decides a plugin's state lives: the last source that names it. Null when no source does (a
// --plugin-dir, synced or skills-dir plugin) or when the CLI cannot write that source (flag, policy).
export function pluginScope(id: string, sources: SettingsSource[]): "user" | "project" | "local" | null {
  let scope: "user" | "project" | "local" | null = null
  for (const { source, settings } of sources)
    if (Object.hasOwn(settings.enabledPlugins ?? {}, id)) scope = CLI_SCOPES[source] ?? null
  return scope
}

const owned = (names: string[], prefix: string) =>
  names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length))

// Off plugins are not in init; they are the enabledPlugins ids whose last setting source turns them off.
function offPlugins(sources: SettingsSource[], on: Set<string>): PluginRow[] {
  const last = new Map<string, { value: unknown; source: string }>()
  for (const { source, settings } of sources)
    for (const [id, value] of Object.entries(settings.enabledPlugins ?? {})) last.set(id, { value, source })

  return [...last].flatMap(([id, { value, source }]) => {
    const [name = id, marketplace = null] = id.split("@")
    if (value !== false || on.has(name)) return []
    const scope = PROJECT_SCOPES.has(source) ? "project" : "global"
    return [
      {
        id: settingId(name, marketplace),
        name,
        marketplace,
        scope,
        on: false,
        brings: { skills: [], mcp: [], commands: [], agents: [], hooks: [] },
      },
    ]
  })
}

export function pluginEntries(
  info: SessionInfo,
  sources: SettingsSource[],
  skillRows: SkillRow[],
  hooks: PluginHook[],
): PluginRow[] {
  const pluginSkills = skillRows.filter((row) => row.source === "plugin").map((row) => row.name)
  const commands = info.slashCommands.filter((name) => !info.skills.includes(name))
  const servers = info.mcpServers.filter((server) => server.source === "plugin").map((server) => server.name)

  const on = info.plugins.map(({ name, source }): PluginRow => {
    const ownHooks = hooks
      .filter((hook) => hook.pluginName === source || hook.pluginName === name)
      .map(({ event, matcher }) => (matcher === "" ? event : `${event} ${matcher}`))
    const marketplace = source?.split("@")[1] ?? null
    return {
      id: settingId(name, marketplace),
      name,
      marketplace,
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
