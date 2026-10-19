import { expect, test } from "bun:test"
import { type Command, hintValues, matchCommands, withOwnCommands } from "./commands.ts"

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
