import { expect, test } from "bun:test"
import { type PaletteRow, paletteRows, rankRows } from "./rows.ts"

const command = (name: string, extra = {}) => ({ name, description: "", argumentHint: "", aliases: [], ...extra })

const rows = paletteRows({
  commands: [
    command("theme"),
    command("settings"),
    command("rename", { argumentHint: "<name>", builtin: true }),
    command("deep-research", { builtin: false }),
    command("clear", { aliases: ["reset"], builtin: true }),
  ],
  actions: {
    sidebar: true,
    ultracode: false,
    agents: false,
    mode: true,
    "effort-up": false,
    "effort-down": false,
    background: false,
  },
  models: [],
  sessions: { entries: [], names: null },
  settings: [
    {
      key: "theme",
      section: "Appearance",
      label: "Theme",
      options: [{ value: "dark", label: "Dark" }],
      value: () => "dark",
      set() {},
      reset() {},
    },
  ],
  now: 0,
})

const ids = (ranked: { row: PaletteRow }[]) => ranked.map(({ row }) => row.id)

test("an empty search lists YellowCode's commands, the actions, then the provider's, and leaves skills to a search", () => {
  expect(ids(rankRows(rows, ""))).toEqual([
    "command:theme",
    "command:settings",
    "action:sidebar",
    "action:mode",
    "command:clear",
    "command:rename",
    "setting:theme",
  ])
})

test("a search ranks exact names, then prefixes, word starts, aliases and text inside, across the kinds", () => {
  expect(ids(rankRows(rows, "theme"))).toEqual(["command:theme", "setting:theme"])
  expect(ids(rankRows(rows, "re"))).toEqual(["command:rename", "command:deep-research", "command:clear"])
  const [side] = rankRows(rows, "side")
  expect(side?.row.id).toBe("action:sidebar")
  expect(side?.match).toEqual({ start: 7, end: 11 })
  expect(ids(rankRows(rows, "dark"))).toEqual(["setting:theme"])
  expect(ids(rankRows(rows, "/the"))).toEqual(["command:theme"])
})

test("a command that needs an argument is written into the prompt", () => {
  expect(rows.find((row) => row.id === "command:rename")?.target).toEqual({
    kind: "command",
    name: "rename",
    fill: true,
  })
})
