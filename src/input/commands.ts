import { log } from "../log/log.ts"
import { modCommands } from "../mods/registry.ts"
import type { Prompt } from "../agent/agent.ts"
import type { CommandRow as ListedCommand, ModelRow } from "../agent/lists.ts"

// `builtin` is the agent's own command (/model, /clear, and a few bundled skills), not a skill or a custom command.
// `mod` names the mod that added it.
export type Command = {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
  builtin?: boolean
  mod?: string
}

// `match` is the typed run inside the shown text: the name, or the alias on an alias row.
export type CommandRow = Pick<Command, "name" | "description" | "argumentHint"> & {
  match: { start: number; end: number }
  alias?: string
}

export const OWN_COMMANDS: Command[] = [
  { name: "settings", description: "Open YellowCode settings", argumentHint: "", aliases: [] },
  { name: "report", description: "Copy a summary of your setup for a bug report", argumentHint: "", aliases: [] },
  { name: "resume", description: "Resume a session from this project", argumentHint: "", aliases: [] },
  { name: "agent", description: "Start a new session with another agent", argumentHint: "", aliases: [] },
  { name: "rewind", description: "Go back to before a prompt", argumentHint: "", aliases: [] },
  { name: "timeline", description: "Move through the prompts of this session", argumentHint: "", aliases: [] },
  { name: "redo", description: "Bring back what the last rewind hid", argumentHint: "", aliases: [] },
  { name: "theme", description: "Choose the theme", argumentHint: "", aliases: [] },
  { name: "mcp", description: "See the MCP servers of this session", argumentHint: "", aliases: [] },
  { name: "skills", description: "See the skills of this session", argumentHint: "", aliases: [] },
  { name: "plugins", description: "See the plugins of this session", argumentHint: "", aliases: [] },
  { name: "mods", description: "See and manage your mods", argumentHint: "", aliases: [] },
  { name: "export", description: "Copy the conversation or save it as Markdown", argumentHint: "[file]", aliases: [] },
]

// The agent's commands without the ones that work only in its own terminal UI, each name once, then YellowCode's.
export function agentCommands(commands: ListedCommand[], terminalOnly: readonly string[]): Command[] {
  const hidden = new Set(terminalOnly)
  const seen = new Set<string>()
  const unique = commands.filter(({ name }) => !hidden.has(name) && !seen.has(name) && seen.add(name))
  return withOwnCommands(
    unique.map(({ name, description, argumentHint, aliases, builtin }) => ({
      name,
      description,
      argumentHint,
      aliases,
      builtin,
    })),
  )
}

// The agent's listed command a message runs: its text starts with the command's name or an alias.
export function commandOf(text: string, commands: ListedCommand[] = []): Prompt["command"] {
  const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  const name = typed?.[1]
  const found = name && commands.find((command) => command.name === name || command.aliases.includes(name))
  return found ? { name: found.name, args: typed?.[2]?.trim() ?? "" } : null
}

// An own command hides recorded commands and aliases with its name, so the list shows it once.
export function withOwnCommands(commands: Command[]): Command[] {
  const own = new Set(OWN_COMMANDS.map((command) => command.name.toLowerCase()))
  const kept: Command[] = []
  for (const command of commands) {
    if (own.has(command.name.toLowerCase())) continue
    kept.push({ ...command, aliases: command.aliases.filter((alias) => !own.has(alias.toLowerCase())) })
  }
  return [...kept, ...OWN_COMMANDS]
}

// A mod's command never hides one of YellowCode's or Claude Code's; it is left out, and the clash is logged.
const clashes = new Set<string>()
export function withModCommands(commands: Command[]): Command[] {
  const taken = new Set(
    commands.flatMap((command) => [command.name, ...command.aliases].map((name) => name.toLowerCase())),
  )
  const added: Command[] = []
  for (const command of modCommands()) {
    const name = command.name.toLowerCase()
    if (taken.has(name)) {
      if (!clashes.has(`${command.mod}/${name}`)) log.warn(`mod ${command.mod}: /${name} is taken, left out`)
      clashes.add(`${command.mod}/${name}`)
      continue
    }
    taken.add(name)
    added.push({
      name: command.name,
      description: `${command.mod} · ${command.description}`,
      argumentHint: command.argumentHint ?? "",
      aliases: [],
      mod: command.mod,
    })
  }
  return [...commands, ...added]
}

// The mod command a typed /name runs, when the shown list has it from a mod.
export function findModCommand(commands: Command[], name: string) {
  const shown = findCommand(commands, name)
  if (!shown?.mod) return undefined
  return modCommands().find((command) => command.mod === shown.mod && command.name === shown.name)
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function byName(a: CommandRow, b: CommandRow): number {
  const left = a.alias ?? a.name
  const right = b.alias ?? b.name
  return left < right ? -1 : left > right ? 1 : 0
}

function wordStart(name: string, needle: string): number {
  let start = 0
  for (const word of name.split(/[-_:]/)) {
    if (word.startsWith(needle)) return start
    start += word.length + 1
  }
  return -1
}

export function matchCommands(commands: Command[], query: string): CommandRow[] {
  const needle = query.toLowerCase()
  const groups: CommandRow[][] = [[], [], []]
  for (const command of commands) {
    const row = { name: command.name, description: flatten(command.description), argumentHint: command.argumentHint }
    const name = command.name.toLowerCase()
    const word = wordStart(name, needle)
    if (name.startsWith(needle)) groups[0]?.push({ ...row, match: { start: 0, end: needle.length } })
    else if (word >= 0) groups[1]?.push({ ...row, match: { start: word, end: word + needle.length } })
    else {
      for (const alias of command.aliases) {
        if (alias.toLowerCase().startsWith(needle))
          groups[2]?.push({ ...row, alias, match: { start: 0, end: needle.length } })
      }
    }
  }
  return groups.flatMap((group) => group.toSorted(byName))
}

export type ArgumentValue = { value: string; note: string }

const OPENERS = "<[("
const CLOSERS = ">])"

function firstGroup(hint: string): string {
  const text = hint.trim()
  if (text === "" || !OPENERS.includes(text.charAt(0))) return text
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (OPENERS.includes(char)) depth++
    else if (CLOSERS.includes(char)) depth--
    if (depth === 0) return text.slice(1, index)
  }
  return text.slice(1)
}

function topLevelAlternatives(group: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < group.length; index++) {
    const char = group.charAt(index)
    if (OPENERS.includes(char)) depth++
    else if (CLOSERS.includes(char)) depth--
    else if (char === "|" && depth === 0) {
      parts.push(group.slice(start, index))
      start = index + 1
    }
  }
  parts.push(group.slice(start))
  return parts
}

// A single alternative is free text ("<name>", "[instructions]"); placeholders like "<tokens>" are not values.
export function hintValues(hint: string): string[] {
  const alternatives = topLevelAlternatives(firstGroup(hint))
  if (alternatives.length < 2) return []
  const words = alternatives.map((alternative) => alternative.trim().split(/\s+/)[0] ?? "")
  return [...new Set(words.filter((word) => word !== "" && !OPENERS.includes(word.charAt(0))))]
}

export function findCommand(commands: Command[], name: string): Command | null {
  const needle = name.toLowerCase()
  return (
    commands.find(
      (command) =>
        command.name.toLowerCase() === needle || command.aliases.some((alias) => alias.toLowerCase() === needle),
    ) ?? null
  )
}

const TITLED_WORDS = 3

// A message running one of Claude Code's own commands gives a session no title (/model sonnet), unless the user's own
// words follow it (/deep-research tokio against smol); /rename names the session itself.
export function untitledCommand(commands: Command[], text: string): boolean {
  const [, name, args = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim()) ?? []
  const command = name === undefined ? null : findCommand(commands, name)
  if (command?.builtin !== true) return false
  return command.name === "rename" || args.split(/\s+/).filter(Boolean).length < TITLED_WORDS
}

export function argumentValues(command: Command, models: ModelRow[]): ArgumentValue[] {
  if (command.name === "model" && models.length > 0) return models.map(({ ref, note }) => ({ value: ref.id, note }))
  return hintValues(command.argumentHint).map((value) => ({ value, note: "" }))
}

export function matchValues(values: ArgumentValue[], query: string): ArgumentValue[] {
  const needle = query.toLowerCase()
  const prefix = values.filter(({ value }) => value.toLowerCase().startsWith(needle))
  const inside = values.filter(
    ({ value }) => !value.toLowerCase().startsWith(needle) && value.toLowerCase().includes(needle),
  )
  return [...prefix, ...inside]
}
