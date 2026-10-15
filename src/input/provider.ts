import type { Accessor } from "solid-js"
import { log } from "../log/log.ts"
import type { PluginHook, SettingsSource, SkillRow } from "../protocol/messages.ts"
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
import { type ArgumentValue, type Command, withOwnCommands } from "./commands.ts"
import { suggestFiles } from "./files.ts"

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

export function replayProvider(recording: Recording): InputProvider {
  const commands = withOwnCommands(
    recordedCommands(recording).map(({ name, description, argumentHint, aliases }) => ({
      name,
      description,
      argumentHint,
      aliases: aliases ?? [],
    })),
  )
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
    files: (query) => Promise.resolve(suggestFiles(query)),
  }
}
