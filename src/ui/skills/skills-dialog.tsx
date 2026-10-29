import { createSignal, onCleanup } from "solid-js"
import type { Agent } from "../../agent/agent.ts"
import type { SkillRow } from "../../agent/lists.ts"
import { matchSkills, SKILL_GROUPS } from "../../session/skills.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog, type FooterAction } from "../dialog/dialog.tsx"
import type { DialogRow, DialogSection } from "../dialog/list.ts"
import { SAVED_NOTICE } from "../format.ts"

const WIDTH = 96
const MIN_HEIGHT = 14
const NOTICE_MS = 4000

// Space types into the search once it has text.
const footer = (query: string, toggles: boolean): FooterAction[] => [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "use", needsRow: true },
  ...(query || !toggles ? [] : [{ key: "space", action: "on/off", needsRow: true }]),
  { key: "esc", action: "close" },
]

function skillRow(skill: SkillRow, uses: number): DialogRow {
  const row: DialogRow = {
    id: skill.id,
    label: skill.label,
    tag: skill.plugin ?? undefined,
    detail: skill.description,
    ...(uses > 0 ? { value: `${uses}×` } : {}),
  }
  if (skill.enabled) return row
  return {
    ...row,
    marker: { text: "◯", fg: theme.panelFaint },
    labelColor: theme.panelFaint,
    valueColor: theme.panelFaint,
  }
}

// Without a search, the skills used this session come first in their group, the most used first.
const skillSections = (skills: SkillRow[], uses: Map<string, number>, usedFirst: boolean): DialogSection[] =>
  SKILL_GROUPS.map(([group, title]) => {
    const inGroup = skills.filter((skill) => skill.group === group)
    const ordered = usedFirst ? inGroup.toSorted((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0)) : inGroup
    return { title, rows: ordered.map((skill) => skillRow(skill, uses.get(skill.id) ?? 0)) }
  }).filter((section) => section.rows.length > 0)

export function SkillsDialog(props: {
  skills: SkillRow[]
  uses: Map<string, number>
  // Live only; without it Space only shows the notice.
  actions?: Agent["skills"]
  // The agent turns skills on and off.
  toggles: boolean
  // The agent's name, for its locked skills.
  agent: string
  onUse: (command: string) => void
  onClose: () => void
}) {
  const [notice, setNotice] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })
  const showNotice = (text: string) => {
    if (disposed) return
    clearTimeout(timer)
    setNotice(text)
    timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
  }
  const skillOf = (row: DialogRow | undefined) => props.skills.find((skill) => skill.id === row?.id)

  return (
    <Dialog
      title="Skills"
      width={WIDTH}
      sections={skillSections(props.skills, props.uses, true)}
      filter={(_, query) => skillSections(matchSkills(props.skills, query), props.uses, query === "")}
      searchPlaceholder="Search skills"
      footer={(row, query) => footer(query, props.toggles && skillOf(row)?.locked !== true)}
      footerStyle="keys"
      notice={notice()}
      view="list"
      minHeight={MIN_HEIGHT}
      onEnter={(row) => {
        const skill = skillOf(row)
        if (skill && skill.command !== null) props.onUse(skill.command)
      }}
      onKey={(key, row, query) => {
        if (key.name !== "space" || query || !props.toggles) return false
        const skill = skillOf(row)
        if (!skill) return true
        if (skill.locked) {
          showNotice(`Locked by ${props.agent} settings`)
          return true
        }
        if (props.actions)
          void props.actions.toggle(skill.id, !skill.enabled).then((outcome) => {
            if (!outcome.ok) showNotice(outcome.problem)
          })
        else showNotice(SAVED_NOTICE)
        return true
      }}
      onEscape={props.onClose}
      empty={(query) => (query ? `No skills match "${query}".` : "No skills in this session.")}
    />
  )
}
