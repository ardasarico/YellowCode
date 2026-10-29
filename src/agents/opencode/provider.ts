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

// The agent's /clear is its own terminal's (opencode's, Codex's); here YellowCode starts a new session.
const CLEAR: CommandRow = {
  name: "clear",
  description: "Start a new session; this one stays in /resume",
  argumentHint: "",
  aliases: [],
  builtin: false,
  setting: null,
  knob: null,
}

// The lists of the session on screen, for an agent that tells them as events: its commands, then /clear, `extra`,
// YellowCode's commands and the mods'.
export const listedProvider = (
  store: () => SessionStore,
  files: (query: string) => Promise<string[]>,
  extra: CommandRow[] = [],
): InputProvider => ({
  commands: () => withModCommands(agentCommands([...(store().lists().commands ?? []), CLEAR, ...extra], [])),
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

// opencode's lists, with /permissions.
export const opencodeProvider = (store: () => SessionStore, files: (query: string) => Promise<string[]>) =>
  listedProvider(store, files, [PERMISSIONS])
