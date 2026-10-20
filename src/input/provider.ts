import { type Accessor, createSignal } from "solid-js"
import { log } from "../log/log.ts"
import {
  fileSuggestions,
  type ModelInfo,
  type PluginHook,
  type SettingsSource,
  type SkillRow,
  type SlashCommand,
} from "../protocol/messages.ts"
import { fileSuggestionsRequest } from "../protocol/outgoing.ts"
import { MODELS } from "../session/settings.ts"
import { type Skill, skillList } from "../session/skills.ts"
import {
  type Recording,
  recordedCommands,
  recordedInitLists,
  recordedModels,
  recordedPluginHooks,
  recordedSettingsSources,
  recordedSkillRows,
} from "../source/recording.ts"
import type { Requests } from "../source/requests.ts"
import { type ArgumentValue, claudeCommands, type Command } from "./commands.ts"
import { suggestFiles } from "./files.ts"

const FILES_TIMEOUT_MS = 5000
const FILE_ROWS = 15

export type InputProvider = {
  commands: Accessor<Command[]>
  models: Accessor<ArgumentValue[]>
  skills: Accessor<Skill[]>
  settingsSources: Accessor<SettingsSource[]>
  // Null while Claude Code has not answered the skills dialog request.
  skillRows: Accessor<SkillRow[] | null>
  pluginHooks: Accessor<PluginHook[]>
  files(query: string): Promise<string[]>
}

// Fed by claude's initialize reply and the messages after it; until then the lists hold only what YellowCode knows.
export type LiveProvider = InputProvider & {
  setCommands(commands: SlashCommand[]): void
  setTerminalOnly(names: string[]): void
  setModels(models: ModelInfo[]): void
}

export function liveProvider(requests: Requests): LiveProvider {
  let raw: SlashCommand[] = []
  let terminalOnly: string[] = []
  // Rewinding a live session waits for hidden git snapshots and --resume-session-at.
  const shown = () =>
    claudeCommands(raw, terminalOnly).filter((command) => command.name !== "rewind" && command.name !== "redo")
  const [commands, setCommands] = createSignal(shown())
  const [models, setModels] = createSignal<ArgumentValue[]>(MODELS.map((value) => ({ value, note: "" })))
  return {
    commands,
    models,
    setCommands(next) {
      raw = next
      setCommands(shown())
    },
    setTerminalOnly(names) {
      terminalOnly = names
      setCommands(shown())
    },
    setModels(next) {
      setModels(next.map(({ value, description }) => ({ value, note: description ?? "" })))
    },
    skills: () => [],
    settingsSources: () => [],
    skillRows: () => null,
    pluginHooks: () => [],
    async files(query) {
      try {
        const reply = await requests.send((id) => fileSuggestionsRequest(id, query), FILES_TIMEOUT_MS)
        // A folder query lists the folder itself first; picking it would only reopen the same list.
        const paths = (fileSuggestions.safeParse(reply).data?.suggestions ?? [])
          .map(({ path }) => path)
          .filter((path) => path !== query)
        if (paths.length > 0) return paths.slice(0, FILE_ROWS)
        // claude answers nothing while its index is cold, and it finds a new file only seconds after it appears; git
        // has both (and nothing either when nothing matches).
        log.debug("file suggestions from git: claude found nothing")
        return await suggestFiles(query)
      } catch (error) {
        log.debug("file suggestions failed", error instanceof Error ? error.message : error)
        return suggestFiles(query)
      }
    },
  }
}

export function replayProvider(recording: Recording): InputProvider {
  const commands = claudeCommands(recordedCommands(recording), [])
  const recorded = recordedModels(recording).map(({ value, description }) => ({ value, note: description ?? "" }))
  const models = recorded.length > 0 ? recorded : MODELS.map((value) => ({ value, note: "" }))
  const { rows, problem, recorded: replied } = recordedSkillRows(recording)
  if (problem !== null) log.warn("skills reply", problem)
  const sources = recordedSettingsSources(recording)
  const skills = skillList(rows, recordedInitLists(recording), sources)
  const hooks = recordedPluginHooks(recording)
  return {
    commands: () => commands,
    models: () => models,
    skills: () => skills,
    settingsSources: () => sources,
    skillRows: () => (replied ? rows : null),
    pluginHooks: () => hooks,
    files: suggestFiles,
  }
}
