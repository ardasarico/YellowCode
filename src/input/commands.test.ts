import { expect, test } from "bun:test"
import { toCommandRows } from "../agents/claude/lists.ts"
import {
  agentCommands,
  type Command,
  commandOf,
  hintValues,
  matchCommands,
  OWN_COMMANDS,
  untitledCommand,
  withOwnCommands,
} from "./commands.ts"

const command = (name: string, aliases: string[] = [], description = ""): Command => ({
  name,
  description,
  argumentHint: "",
  aliases,
})

const commands = [
  command("usage", ["cost"], "Show\n  usage"),
  command("compact"),
  command("context"),
  command("add-dir"),
  command("review-code"),
]

test("an empty query lists every name alphabetically", () => {
  expect(matchCommands(commands, "").map((row) => row.name)).toEqual([
    "add-dir",
    "compact",
    "context",
    "review-code",
    "usage",
  ])
})

test("name prefixes come before word prefixes before aliases", () => {
  const shown = (query: string) => matchCommands(commands, query).map((row) => row.alias ?? row.name)
  expect(shown("c")).toEqual(["compact", "context", "review-code", "cost"])
  expect(matchCommands(commands, "dir").map((row) => row.name)).toEqual(["add-dir"])
})

test("an alias row keeps the command's name and one-line description and is skipped when the name matched", () => {
  expect(matchCommands(commands, "cos")).toEqual([
    { name: "usage", alias: "cost", description: "Show usage", argumentHint: "", match: { start: 0, end: 3 } },
  ])
  expect(matchCommands([command("usage", ["us"])], "us").map((row) => row.alias)).toEqual([undefined])
})

test("the match is the typed run in the name, the word or the alias", () => {
  expect(matchCommands(commands, "co").map((row) => [row.alias ?? row.name, row.match])).toEqual([
    ["compact", { start: 0, end: 2 }],
    ["context", { start: 0, end: 2 }],
    ["review-code", { start: 7, end: 9 }],
    ["cost", { start: 0, end: 2 }],
  ])
})

test("hint values are the first group's top-level alternatives", () => {
  expect(hintValues("<low|medium|high|xhigh|max|auto|ultracode [on|off]>")).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "auto",
    "ultracode",
  ])
  expect(hintValues("[reconnect|enable|disable [<server>|all]]")).toEqual(["reconnect", "enable", "disable"])
  expect(hintValues("[low|max|ultra] [--fix] [<pr#>|<branch>]")).toEqual(["low", "max", "ultra"])
  expect(hintValues("[auto|<tokens>]")).toEqual(["auto"])
  expect(hintValues("consent | revoke")).toEqual(["consent", "revoke"])
  for (const free of ["<name>", "[instructions]", "[interval] [prompt]", "[prompt-audit [<path>]]", "key=value", ""]) {
    expect(hintValues(free)).toEqual([])
  }
})

test("an own command hides a recorded alias with its name", () => {
  const merged = withOwnCommands([command("config", ["settings"])])
  expect(matchCommands(merged, "set").map((row) => row.name)).toEqual(["settings"])
  expect(merged.find((entry) => entry.name === "config")?.aliases).toEqual([])
})

const cliRow = (name: string, aliases?: string[]) => ({ name, description: "", argumentHint: "", aliases })

test("Claude Code's commands keep their aliases and drop help, internal, blocked and terminal-only names", () => {
  const rows = ["help", "__debug", "doctor", "fast", "mcp"]
    .map((name) => cliRow(name))
    .concat(cliRow("clear", ["reset", "new"]))
  const merged = agentCommands(toCommandRows(rows), ["doctor"])
  // Own commands come last, and the own /mcp hides claude's.
  expect(merged.slice(0, -OWN_COMMANDS.length)).toEqual([{ ...command("clear", ["reset", "new"]), builtin: false }])
  expect(merged.slice(-OWN_COMMANDS.length)).toEqual(OWN_COMMANDS)
})

test("Claude Code's own commands get a title only from the user's words after them", () => {
  const own = (name: string, aliases: string[] = []): Command => ({ ...command(name, aliases), builtin: true })
  const list = [own("model"), own("deep-research"), own("rename"), own("usage", ["cost"]), command("fix-issue")]
  expect(untitledCommand(list, "/model sonnet")).toBe(true)
  expect(untitledCommand(list, "/cost")).toBe(true)
  expect(untitledCommand(list, "/deep-research tokio against smol")).toBe(false)
  expect(untitledCommand(list, "/rename my new session name")).toBe(true)
  expect(untitledCommand(list, "/fix-issue 123")).toBe(false)
  expect(untitledCommand(list, "plain words")).toBe(false)
})

test("a message runs a listed command only when its text starts with the command's name or alias", () => {
  const listed = [{ ...command("hello", ["hi"]), builtin: false, setting: null, knob: null }]
  expect(commandOf("/hello the team\nand more", listed)).toEqual({ name: "hello", args: "the team\nand more" })
  expect(commandOf("/hi", listed)).toEqual({ name: "hello", args: "" })
  expect(commandOf("/hellothere", listed)).toBeNull()
  expect(commandOf("say /hello", listed)).toBeNull()
  expect(commandOf("/hello")).toBeNull()
})
