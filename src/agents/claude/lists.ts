import type { ModeId } from "../../agent/ids.ts"
import type { CommandRow, EffortRow, ModelRow, ModeRow } from "../../agent/lists.ts"
import { rowsOf } from "../../json.ts"
import { modelInfo, type ModelInfo, slashCommand, type SlashCommand } from "../../protocol/messages.ts"

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]

export const CLAUDE_EFFORTS: EffortRow[] = EFFORT_LEVELS.map((id) => ({ id, label: id }))

// In the order Shift+Tab walks the cycling ones: auto, accept edits, plan. "default" is "manual" to the user.
export const CLAUDE_MODES: ModeRow[] = [
  { id: "auto", label: "auto", description: "", kind: "auto", cycle: true, available: true, group: null },
  { id: "default", label: "manual", description: "", kind: "default", cycle: false, available: true, group: null },
  {
    id: "acceptEdits",
    label: "acceptEdits",
    description: "",
    kind: "edits",
    cycle: true,
    available: true,
    group: null,
  },
  { id: "plan", label: "plan", description: "", kind: "plan", cycle: true, available: true, group: null },
  {
    id: "bypassPermissions",
    label: "bypassPermissions",
    description: "Every tool runs without asking.",
    kind: "bypass",
    cycle: false,
    available: true,
    group: null,
  },
  {
    id: "dontAsk",
    label: "dontAsk",
    description: "Tools not pre-approved are denied without asking.",
    kind: "other",
    cycle: false,
    available: true,
    group: null,
  },
]

// One of claude's modes, which YellowCode can start it in.
export const isClaudeMode = (id: ModeId | null): boolean => CLAUDE_MODES.some((mode) => mode.id === id)

// Claude Code's commands YellowCode does not offer: broken over stream-json, internal, or covered by its own views.
export const BLOCKED_COMMANDS = [
  "debug",
  "doctor",
  "heapdump",
  "fast",
  "agents",
  "workflow-launch-exec",
  "auto-mode-setup",
  "recap",
  "list-agents",
]

// Bare, these open their row in /settings; with a value they go to claude as typed.
const SETTING_COMMANDS: Record<string, string> = {
  config: "outputStyle",
  "output-style": "outputStyle",
  autocompact: "autoCompactWindow",
}

export const settingOf = (name: string): string | null => SETTING_COMMANDS[name] ?? null

// The / list leaves out help, internal commands (__x) and the ones YellowCode does not offer.
export const toCommandRows = (commands: SlashCommand[]): CommandRow[] =>
  commands
    .filter(({ name }) => !BLOCKED_COMMANDS.includes(name) && name !== "help" && !name.startsWith("__"))
    .map(({ name, description, argumentHint, aliases, builtin }) => ({
      name,
      description,
      argumentHint,
      aliases: aliases ?? [],
      builtin: builtin ?? false,
      setting: settingOf(name),
    }))

export const commandsOf = (rows: unknown[]): CommandRow[] => toCommandRows(rowsOf(slashCommand, rows).rows)

export const toModelRows = (models: ModelInfo[]): ModelRow[] =>
  models.map(({ value, description, resolvedModel }) => ({
    ref: { provider: null, id: value },
    label: value,
    note: description ?? "",
    resolves: resolvedModel ?? null,
    efforts: CLAUDE_EFFORTS,
    images: true,
  }))

export const modelsOf = (rows: unknown[]): ModelRow[] => toModelRows(rowsOf(modelInfo, rows).rows)
