import { createSignal } from "solid-js"
import type { CommandRow, ModelRow } from "../../agent/lists.ts"
import { agentCommands, withModCommands } from "../../input/commands.ts"
import { suggestFiles } from "../../input/files.ts"
import type { InputProvider } from "../../input/provider.ts"
import { log } from "../../log/log.ts"
import type { SettingsSource, SkillRow } from "../../protocol/messages.ts"
import {
  type Recording,
  recordedCommands,
  recordedInitLists,
  recordedModels,
  recordedSettingsSources,
  recordedSkillRows,
} from "../../source/recording.ts"
import { MODELS } from "../../session/settings.ts"
import { BLOCKED_COMMANDS, CLAUDE_EFFORTS, CLAUDE_MODES, knobOf, settingOf } from "./lists.ts"
import { type InitLists, skillList } from "./skills.ts"

const SOURCE_NAMES = ["user", "project", "local", "flag", "policy"]

const sourceNames = (sources: SettingsSource[]) =>
  SOURCE_NAMES.filter((name) => sources.some(({ source }) => source === `${name}Settings`))

const blocked = (name: string) => BLOCKED_COMMANDS.includes(name)

// The models YellowCode knows until claude lists its own; every Claude model has the same effort levels.
const knownClaudeModels = (): ModelRow[] =>
  MODELS.map((id) => ({
    ref: { provider: null, id },
    label: id,
    note: "",
    resolves: null,
    efforts: CLAUDE_EFFORTS,
    images: true,
    window: null,
  }))

// Fed by claude's initialize reply and the messages after it; until then the lists hold only what YellowCode knows.
export type LiveProvider = InputProvider & {
  // claude's own rows, which the skill and plugin switches read.
  skillRows(): SkillRow[] | null
  settingsSources(): SettingsSource[]
  setCommands(commands: CommandRow[]): void
  // Commands the agent lists but runs only in its own terminal UI.
  setTerminalOnly(names: string[]): void
  setModels(models: ModelRow[]): void
  setSkillRows(rows: SkillRow[]): void
  setSettingsSources(sources: SettingsSource[]): void
  setInitLists(lists: InitLists): void
  setPlan(plan: string | null): void
  // A skill whose new state claude has not reported yet shows it already; null drops that.
  setPendingSkill(name: string, enabled: boolean | null): void
}

export function liveProvider(files: (query: string) => Promise<string[]>): LiveProvider {
  let raw: CommandRow[] = []
  let terminalOnly: string[] = []
  const shown = () => agentCommands(raw, terminalOnly)
  const [commands, setCommands] = createSignal(shown())
  const [models, setModels] = createSignal(knownClaudeModels())
  const [skillRows, setSkillRows] = createSignal<SkillRow[] | null>(null)
  const [sources, setSources] = createSignal<SettingsSource[]>([])
  const [initLists, setInitLists] = createSignal<InitLists | null>(null)
  const [pending, setPending] = createSignal(new Map<string, boolean>())
  const [plan, setPlan] = createSignal<string | null>(null)
  return {
    commands: () => withModCommands(commands()),
    blocked,
    setting: settingOf,
    knob: knobOf,
    models,
    modes: () => CLAUDE_MODES,
    setCommands(next) {
      raw = next
      setCommands(shown())
    },
    setTerminalOnly(names) {
      terminalOnly = names
      setCommands(shown())
    },
    setModels: (next) => setModels(next),
    skills: () => {
      const rows = skillRows()
      if (rows === null) return null
      const skills = skillList(rows, initLists(), sources())
      for (const skill of skills) skill.enabled = pending().get(skill.name) ?? skill.enabled
      return skills
    },
    settingSources: () => sourceNames(sources()),
    skillRows,
    settingsSources: sources,
    setSkillRows: (rows) => setSkillRows(rows),
    setSettingsSources: (next) => setSources(next),
    setInitLists: (lists) => setInitLists(lists),
    plan,
    setPlan: (next) => setPlan(next),
    setPendingSkill(name, enabled) {
      setPending((current) => {
        const next = new Map(current)
        if (enabled === null) next.delete(name)
        else next.set(name, enabled)
        return next
      })
    },
    files,
  }
}

export function replayProvider(recording: Recording): InputProvider {
  const commands = agentCommands(recordedCommands(recording), [])
  const recorded = recordedModels(recording)
  const models = recorded.length > 0 ? recorded : knownClaudeModels()
  const { rows, problem, recorded: replied } = recordedSkillRows(recording)
  if (problem !== null) log.warn("skills reply", problem)
  const sources = recordedSettingsSources(recording)
  const skills = replied ? skillList(rows, recordedInitLists(recording), sources) : null
  const names = sourceNames(sources)
  return {
    commands: () => withModCommands(commands),
    blocked,
    setting: settingOf,
    knob: knobOf,
    models: () => models,
    modes: () => CLAUDE_MODES,
    skills: () => skills,
    settingSources: () => names,
    plan: () => null,
    files: suggestFiles,
  }
}

// A read-only transcript is no live project, so its dialogs show none of claude's lists.
export const savedProvider = (provider: InputProvider): InputProvider => ({
  ...provider,
  skills: () => null,
  settingSources: () => [],
})
