export type Command = { name: string; description: string; argumentHint: string; aliases: string[] }

export type CommandRow = Pick<Command, "name" | "description" | "argumentHint">

export const OWN_COMMANDS: Command[] = [
  { name: "settings", description: "Open YellowCode settings", argumentHint: "", aliases: [] },
  { name: "resume", description: "Resume a session from this project", argumentHint: "", aliases: [] },
  { name: "theme", description: "Choose the theme", argumentHint: "", aliases: [] },
  { name: "mcp", description: "See the MCP servers of this session", argumentHint: "", aliases: [] },
]

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

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function byName(a: CommandRow, b: CommandRow): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

export function matchCommands(commands: Command[], query: string): CommandRow[] {
  const needle = query.toLowerCase()
  const groups: CommandRow[][] = [[], [], []]
  for (const command of commands) {
    const row = { name: command.name, description: flatten(command.description), argumentHint: command.argumentHint }
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) groups[0]?.push(row)
    else if (name.split(/[-_:]/).some((word) => word.startsWith(needle))) groups[1]?.push(row)
    else {
      for (const alias of command.aliases) {
        if (alias.toLowerCase().startsWith(needle)) groups[2]?.push({ ...row, name: alias })
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

export function argumentValues(command: Command, models: ArgumentValue[]): ArgumentValue[] {
  if (command.name === "model" && models.length > 0) return models
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
