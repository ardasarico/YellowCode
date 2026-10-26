import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readThemes } from "./theme-file.ts"

const dusk = readThemes(mkdtempSync(join(tmpdir(), "yellowcode-themes-"))).find(
  (entry) => entry.id === "dusk",
)?.definition
if (!dusk) throw new Error("the built-in dusk theme did not load")

test("a user theme loads, or says what is wrong with it", () => {
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-themes-"))
  writeFileSync(join(folder, "forest.json"), JSON.stringify({ name: "Forest", light: dusk.light }))
  const { tile: _tile, ...noTile } = dusk.dark
  writeFileSync(join(folder, "broken.json"), JSON.stringify({ name: "Broken", dark: noTile }))
  writeFileSync(join(folder, "odd.json"), JSON.stringify({ name: "Odd", dark: { ...dusk.dark, accent: "blue" } }))
  writeFileSync(join(folder, "dusk.json"), JSON.stringify({ name: dusk.name, dark: dusk.dark, light: dusk.light }))
  const user = readThemes(folder).filter((entry) => entry.source === "user")
  expect(user.map((entry) => [entry.id, entry.problem])).toEqual([
    ["broken", "dark.tile missing"],
    ["dusk", "a built-in theme has this name"],
    ["forest", null],
    ["odd", "dark.accent is not a color"],
  ])
  // A light-only theme serves a dark terminal too.
  expect(user.find((entry) => entry.id === "forest")?.definition?.dark).toEqual(dusk.light)
})
