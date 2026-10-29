import type { Accessor } from "solid-js"
import type { Knob, ModelGroup, ModelRow, ModeRow, PluginRow, SkillRow } from "../agent/lists.ts"
import type { SessionInfo } from "../session/types.ts"
import type { Command } from "./commands.ts"

export type InputProvider = {
  commands: Accessor<Command[]>
  // A command the agent has that YellowCode does not offer; typed, it does not go out.
  blocked(name: string): boolean
  // The /settings row a command opens when typed bare, whether or not the agent has listed it yet; null for none.
  setting(name: string): string | null
  // The knob a command of the agent's own sets (CommandRow.knob), whether or not the agent has listed it yet.
  knob(name: string): Knob | null
  models: Accessor<ModelRow[]>
  // For an agent with several providers, `models` by provider; without it, /model shows one list.
  modelGroups?: Accessor<ModelGroup[]>
  modes: Accessor<ModeRow[]>
  // Null while the agent has not listed them.
  skills: Accessor<SkillRow[] | null>
  // The plugins of the session `info` describes; null while the agent has not listed them.
  plugins(info: SessionInfo | null): PluginRow[] | null
  // The settings layers that set something, such as "user" or "project".
  settingSources: Accessor<string[]>
  // The subscription the account is on, such as "Claude Pro"; null when the agent has not said.
  plan: Accessor<string | null>
  files(query: string): Promise<string[]>
}
