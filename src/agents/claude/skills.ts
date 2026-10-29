import type { SkillRow } from "../../agent/lists.ts"
import type { SettingsSource, SkillRow as ClaudeSkillRow } from "../../protocol/messages.ts"
import { compareSkills } from "../../session/skills.ts"

export type InitLists = { skills: string[]; slashCommands: string[] }

const HIDDEN_SOURCES = new Set(["bundled", "built-in"])
export const PROJECT_SCOPES = new Set(["projectSettings", "localSettings"])

export function pluginGroup(plugin: string, sources: SettingsSource[]): "global" | "project" {
  let group: "global" | "project" = "global"
  for (const { source, settings } of sources) {
    const enabled = Object.entries(settings.enabledPlugins ?? {}).some(
      ([id, value]) => (id === plugin || id.startsWith(`${plugin}@`)) && value !== false,
    )
    if (enabled) group = PROJECT_SCOPES.has(source) ? "project" : "global"
  }
  return group
}

function sourceGroup(source: string): SkillRow["group"] {
  if (source === "project") return "project"
  if (source === "claude.ai sync" || source === "managed") return "account"
  return "global"
}

function isLegacyCommand(row: ClaudeSkillRow, init: InitLists | null): boolean {
  if (init === null || (row.source !== "user" && row.source !== "project")) return false
  return init.slashCommands.includes(row.name) && !init.skills.includes(row.name)
}

export function skillList(rows: ClaudeSkillRow[], init: InitLists | null, sources: SettingsSource[]): SkillRow[] {
  const skills: SkillRow[] = []
  for (const row of rows) {
    if (HIDDEN_SOURCES.has(row.source) || isLegacyCommand(row, init)) continue
    const colon = row.name.indexOf(":")
    const plugin = row.source === "plugin" && colon > 0 ? row.name.slice(0, colon) : null
    skills.push({
      id: row.name,
      name: row.name,
      command: row.display_name,
      label: plugin === null ? row.display_name : row.name.slice(colon + 1),
      plugin,
      description: row.description.replace(/\s+/g, " ").trim(),
      group: plugin === null ? sourceGroup(row.source) : pluginGroup(plugin, sources),
      enabled: row.state !== "off",
      locked: row.locked_by !== undefined,
    })
  }
  return skills.toSorted(compareSkills)
}
