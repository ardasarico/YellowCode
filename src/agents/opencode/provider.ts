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

const row = (name: string, description: string, argumentHint = "", knob: CommandRow["knob"] = null): CommandRow => ({
  name,
  description,
  argumentHint,
  aliases: [],
  builtin: true,
  setting: null,
  knob,
})

// What YellowCode does itself for an agent that lists no such command: the knobs, the context report, a name for the
// session and plan mode.
const HANDLED: CommandRow[] = [
  row("model", "Choose the model", "[model]", "model"),
  row("effort", "Choose the effort level", "[level]", "effort"),
  row("context", "See how full the context is"),
  row("rename", "Name this session", "<name>"),
]
const PLAN = row("plan", "Switch to plan mode, or plan what follows", "[task]")

// The lists of the session on screen, for an agent that tells them as events: its commands, then `own` (/clear by
// default), the ones YellowCode handles, YellowCode's commands and the mods'.
export const listedProvider = (
  store: () => SessionStore,
  files: (query: string) => Promise<string[]>,
  own: CommandRow[] = [CLEAR],
): InputProvider => ({
  commands: () => {
    const planning = (store().state.modes ?? []).some((mode) => mode.kind === "plan")
    const handled = planning ? [...HANDLED, PLAN] : HANDLED
    return withModCommands(agentCommands([...(store().lists().commands ?? []), ...own, ...handled], []))
  },
  blocked: () => false,
  setting: () => null,
  knob: () => null,
  models: () => (store().state.models ?? []).flatMap((group) => group.models),
  modelGroups: () => store().state.models ?? [],
  modes: () => store().state.modes ?? [],
  skills: () => store().lists().skills ?? null,
  settingSources: () => [],
  plan: () => null,
  files,
})

// opencode's lists, with /permissions and its own /new for /clear. A command opencode does not list stays here.
export const opencodeProvider = (store: () => SessionStore, files: (query: string) => Promise<string[]>) => ({
  ...listedProvider(store, files, [{ ...CLEAR, aliases: ["new"] }, PERMISSIONS]),
  listedOnly: () => store().lists().commands !== undefined,
})
