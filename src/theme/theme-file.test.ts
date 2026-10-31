import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BUILT_IN_THEMES } from "./built-in.ts"
import { readThemes } from "./theme-file.ts"

const dusk = readThemes(mkdtempSync(join(tmpdir(), "yellowcode-themes-"))).find(
  (entry) => entry.id === "dusk",
)?.definition
if (!dusk) throw new Error("the built-in dusk theme did not load")

test("a user theme loads, or says what is wrong with it", () => {
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-themes-"))
  writeFileSync(join(folder, "meadow.json"), JSON.stringify({ name: "Meadow", light: dusk.light }))
  const { tile: _tile, ...noTile } = dusk.dark
  writeFileSync(join(folder, "broken.json"), JSON.stringify({ name: "Broken", dark: noTile }))
  writeFileSync(join(folder, "odd.json"), JSON.stringify({ name: "Odd", dark: { ...dusk.dark, accent: "blue" } }))
  writeFileSync(join(folder, "dusk.json"), JSON.stringify({ name: dusk.name, dark: dusk.dark, light: dusk.light }))
  const user = readThemes(folder).filter((entry) => entry.source === "user")
  expect(user.map((entry) => [entry.id, entry.problem])).toEqual([
    ["broken", "dark.tile missing"],
    ["dusk", "a built-in theme has this name"],
    ["meadow", null],
    ["odd", "dark.accent is not a color"],
  ])
  // A light-only theme serves a dark terminal too.
  expect(user.find((entry) => entry.id === "meadow")?.definition?.dark).toEqual(dusk.light)
})

test("a wrong kind of value is not called missing", () => {
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-themes-"))
  const write = (id: string, file: unknown) => writeFileSync(join(folder, `${id}.json`), JSON.stringify(file))
  write("agents", { name: "A", dark: { ...dusk.dark, agents: "#ffffff" } })
  write("dark", { name: "B", dark: 5 })
  write("name", { name: 3, dark: dusk.dark })
  write("none", { name: "C" })
  const user = readThemes(folder).filter((entry) => entry.source === "user")
  expect(user.map((entry) => [entry.id, entry.problem])).toEqual([
    ["agents", "dark.agents is not a list of colors"],
    ["dark", "dark is not a set of colors"],
    ["name", "name is not text"],
    ["none", "dark: needs dark or light"],
  ])
})

test("every file in themes/ is a built-in theme", () => {
  const files = readdirSync(join(import.meta.dir, "../../themes")).map((name) => basename(name, ".json"))
  expect(BUILT_IN_THEMES.map(({ id }) => id).toSorted()).toEqual(files.toSorted())
})
