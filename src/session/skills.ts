import type { SkillRow } from "../agent/lists.ts"
import type { Session } from "./types.ts"

export const SKILL_GROUPS: [SkillRow["group"], string][] = [
  ["builtin", "Built-in"],
  ["global", "Global"],
  ["project", "Project"],
  ["account", "claude.ai"],
]

const groupIndex = (group: SkillRow["group"]) => SKILL_GROUPS.findIndex(([id]) => id === group)

export function compareSkills(a: SkillRow, b: SkillRow): number {
  return (
    groupIndex(a.group) - groupIndex(b.group) ||
    a.label.localeCompare(b.label) ||
    (a.plugin ?? "").localeCompare(b.plugin ?? "")
  )
}

export function matchSkills(skills: SkillRow[], query: string): SkillRow[] {
  const needle = query.toLowerCase()
  if (needle === "") return skills
  const has = (text: string) => text.toLowerCase().includes(needle)
  const tier = (skill: SkillRow) => {
    if (has(skill.label)) return 0
    if (has(skill.command ?? "") || has(skill.plugin ?? "") || has(skill.description)) return 1
    return null
  }
  return skills
    .map((skill) => ({ skill, tier: tier(skill) }))
    .filter((entry): entry is { skill: SkillRow; tier: number } => entry.tier !== null)
    .toSorted(
      (a, b) =>
        groupIndex(a.skill.group) - groupIndex(b.skill.group) || a.tier - b.tier || compareSkills(a.skill, b.skill),
    )
    .map(({ skill }) => skill)
}

// How often each skill ran this session, by id: the agent's skill calls and the user's own /command prompts.
export function skillUses(session: Session, skills: SkillRow[]): Map<string, number> {
  const uses = new Map<string, number>()
  const count = (id: string | undefined) => {
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1)
  }
  for (const item of Object.values(session.byId)) {
    if (item.kind === "tool" && item.toolKind === "skill") {
      const input = item.input
      const name = typeof input === "object" && input !== null && "skill" in input ? input.skill : undefined
      count(typeof name === "string" ? skills.find((skill) => skill.name === name)?.id : undefined)
    } else if (item.kind === "user" && item.text.startsWith("/")) {
      const command = item.text.slice(1).split(/\s/)[0]
      count(skills.find((skill) => skill.command === command || skill.name === command)?.id)
    }
  }
  return uses
}
