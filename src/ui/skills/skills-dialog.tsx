import { createSignal, onCleanup } from "solid-js"
import { matchSkills, SKILL_GROUPS, type Skill } from "../../session/skills.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog, type FooterAction } from "../dialog/dialog.tsx"
import type { DialogRow, DialogSection } from "../dialog/list.ts"

// The live connection runs this; without it Space only shows the notice.
export type SkillActions = { setEnabled(skill: Skill, enabled: boolean): void }

const WIDTH = 96
const MIN_HEIGHT = 14
const NOTICE_MS = 4000
const REPLAY_NOTICE = "On/off comes with the live connection"

const FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "use" },
  { key: "space", action: "on/off" },
  { key: "esc", action: "close" },
]

function skillRow(skill: Skill): DialogRow {
  const row: DialogRow = {
    id: skill.name,
    label: skill.label,
    tag: skill.plugin ?? undefined,
    detail: skill.description,
  }
  if (skill.enabled) return row
  return { ...row, marker: { text: "◯", fg: theme.faint }, labelColor: theme.faint, valueColor: theme.faint }
}

const skillSections = (skills: Skill[]): DialogSection[] =>
  SKILL_GROUPS.map(([group, title]) => ({
    title,
    rows: skills.filter((skill) => skill.group === group).map(skillRow),
  })).filter((section) => section.rows.length > 0)

export function SkillsDialog(props: {
  skills: Skill[]
  actions?: SkillActions
  onUse: (command: string) => void
  onClose: () => void
}) {
  const [notice, setNotice] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const showNotice = (text: string) => {
    clearTimeout(timer)
    setNotice(text)
    timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
  }
  const skillOf = (row: DialogRow | undefined) => props.skills.find((skill) => skill.name === row?.id)

  return (
    <Dialog
      title="Skills"
      width={WIDTH}
      sections={skillSections(props.skills)}
      filter={(_, query) => skillSections(matchSkills(props.skills, query))}
      searchPlaceholder="Search skills"
      footer={FOOTER}
      footerStyle="keys"
      notice={notice()}
      view="list"
      minHeight={MIN_HEIGHT}
      onEnter={(row) => {
        const skill = skillOf(row)
        if (skill) props.onUse(skill.command)
      }}
      onKey={(key, row) => {
        if (key.name !== "space") return false
        const skill = skillOf(row)
        if (!skill || skill.locked) return true
        if (props.actions) props.actions.setEnabled(skill, !skill.enabled)
        else showNotice(REPLAY_NOTICE)
        return true
      }}
      onEscape={props.onClose}
      empty={(query) => (query ? `No skills match "${query}".` : "No skills in this session.")}
    />
  )
}
