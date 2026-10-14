import type { Accessor } from "solid-js"
import { log } from "../log/log.ts"
import { MODELS } from "../session/settings.ts"
import { type Skill, skillList } from "../session/skills.ts"
import {
  type Recording,
  recordedCommands,
  recordedInitLists,
  recordedModels,
  recordedSettingsSources,
  recordedSkillRows,
} from "../source/recording.ts"
import { type ArgumentValue, type Command, withOwnCommands } from "./commands.ts"
import { suggestFiles } from "./files.ts"

export type InputProvider = {
  commands: Accessor<Command[]>
  models: Accessor<ArgumentValue[]>
  skills: Accessor<Skill[]>
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
  const { rows, problem } = recordedSkillRows(recording)
  if (problem !== null) log.warn("skills reply", problem)
  const skills = skillList(rows, recordedInitLists(recording), recordedSettingsSources(recording))
  return {
    commands: () => commands,
    models: () => models,
    skills: () => skills,
    files: (query) => Promise.resolve(suggestFiles(query)),
  }
}
