import type { CommandRow } from "../../agent/lists.ts"
import { agentCommands, withModCommands } from "../../input/commands.ts"
import type { InputProvider } from "../../input/provider.ts"
import type { SessionStore } from "../../session/session.ts"

// YellowCode's dialog of the rules opencode saved, which opencode itself offers no command for.
const PERMISSIONS: CommandRow = {
  name: "permissions",
  description: "See and remove the permission rules opencode saved",
  argumentHint: "",
  aliases: [],
  builtin: false,
  setting: null,
  knob: null,
}

// opencode's /clear is its own terminal's; here YellowCode starts a new session.
const CLEAR: CommandRow = {
  name: "clear",
  description: "Start a new session; this one stays in /resume",
  argumentHint: "",
  aliases: [],
  builtin: false,
  setting: null,
  knob: null,
}

// The lists of the session on screen: opencode's commands, then /clear, /permissions, YellowCode's commands and the
// mods'.
export const opencodeProvider = (
  store: () => SessionStore,
  files: (query: string) => Promise<string[]>,
): InputProvider => ({
  commands: () => withModCommands(agentCommands([...(store().lists().commands ?? []), CLEAR, PERMISSIONS], [])),
  blocked: () => false,
  setting: () => null,
  knob: () => null,
  models: () => (store().state.models ?? []).flatMap((group) => group.models),
  modelGroups: () => store().state.models ?? [],
  modes: () => store().state.modes ?? [],
  skills: () => store().lists().skills ?? null,
  plugins: () => store().lists().plugins ?? null,
  settingSources: () => [],
  plan: () => null,
  files,
})
