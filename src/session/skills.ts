import type { SettingsSource, SkillRow } from "../protocol/messages.ts"

export type SkillGroup = "builtin" | "global" | "project" | "claude-ai"

export const SKILL_GROUPS: [SkillGroup, string][] = [
  ["builtin", "Built-in"],
  ["global", "Global"],
  ["project", "Project"],
  ["claude-ai", "claude.ai"],
]

export type Skill = {
  name: string
  command: string
  label: string
  plugin: string | null
  description: string
  group: SkillGroup
  enabled: boolean
  locked: boolean
}

type InitLists = { skills: string[]; slashCommands: string[] }

const HIDDEN_SOURCES = new Set(["bundled", "built-in"])
const PROJECT_SCOPES = new Set(["projectSettings", "localSettings"])

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

function sourceGroup(source: string): SkillGroup {
  if (source === "project") return "project"
  if (source === "claude.ai sync" || source === "managed") return "claude-ai"
  return "global"
}

function isLegacyCommand(row: SkillRow, init: InitLists | null): boolean {
  if (init === null || (row.source !== "user" && row.source !== "project")) return false
  return init.slashCommands.includes(row.name) && !init.skills.includes(row.name)
}

const groupIndex = (group: SkillGroup) => SKILL_GROUPS.findIndex(([id]) => id === group)

function compare(a: Skill, b: Skill): number {
  return (
    groupIndex(a.group) - groupIndex(b.group) ||
    a.label.localeCompare(b.label) ||
    (a.plugin ?? "").localeCompare(b.plugin ?? "")
  )
}

export function skillList(rows: SkillRow[], init: InitLists | null, sources: SettingsSource[]): Skill[] {
  const skills: Skill[] = []
  for (const row of rows) {
    if (HIDDEN_SOURCES.has(row.source) || isLegacyCommand(row, init)) continue
    const colon = row.name.indexOf(":")
    const plugin = row.source === "plugin" && colon > 0 ? row.name.slice(0, colon) : null
    skills.push({
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
  return skills.toSorted(compare)
}

export function matchSkills(skills: Skill[], query: string): Skill[] {
  const needle = query.toLowerCase()
  if (needle === "") return skills
  const has = (text: string) => text.toLowerCase().includes(needle)
  const tier = (skill: Skill) => {
    if (has(skill.label)) return 0
    if (has(skill.command) || has(skill.plugin ?? "") || has(skill.description)) return 1
    return null
  }
  return skills
    .map((skill) => ({ skill, tier: tier(skill) }))
    .filter((entry): entry is { skill: Skill; tier: number } => entry.tier !== null)
    .toSorted(
      (a, b) => groupIndex(a.skill.group) - groupIndex(b.skill.group) || a.tier - b.tier || compare(a.skill, b.skill),
    )
    .map(({ skill }) => skill)
}
