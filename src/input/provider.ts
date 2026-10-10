import type { Accessor } from "solid-js"
import { MODELS } from "../session/settings.ts"
import { type Recording, recordedCommands, recordedModels } from "../source/recording.ts"
import type { ArgumentValue, Command } from "./commands.ts"
import { suggestFiles } from "./files.ts"

export type InputProvider = {
  commands: Accessor<Command[]>
  models: Accessor<ArgumentValue[]>
  files(query: string): Promise<string[]>
}

export function replayProvider(recording: Recording): InputProvider {
  const commands = recordedCommands(recording).map(({ name, description, argumentHint, aliases }) => ({
    name,
    description,
    argumentHint,
    aliases: aliases ?? [],
  }))
  const recorded = recordedModels(recording).map(({ value, description }) => ({ value, note: description ?? "" }))
  const models = recorded.length > 0 ? recorded : MODELS.map((value) => ({ value, note: "" }))
  return { commands: () => commands, models: () => models, files: (query) => Promise.resolve(suggestFiles(query)) }
}
