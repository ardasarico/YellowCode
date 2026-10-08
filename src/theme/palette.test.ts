import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { agentIdentity } from "./agents.ts"
import { isDark, mix, tintsFrom } from "./palette.ts"

const colors = (background: string | null): TerminalColors => ({
  palette: [null, "#ff0000", "#00ff00"],
  defaultForeground: "#ffffff",
  defaultBackground: background,
  cursorColor: null,
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: null,
  highlightForeground: null,
})

test("tints mix the background toward the target color", () => {
  expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080")
  expect(tintsFrom(colors("#000000"))).toMatchObject({ diffAdd: "#002e00", diffDel: "#2e0000" })
})

test("a terminal without a background color gets no tints and counts as dark", () => {
  expect(tintsFrom(colors(null))).toBeNull()
  expect(isDark(null)).toBe(true)
  expect(isDark("#f6efe0")).toBe(false)
})

test("the first ten agents get distinct identities", () => {
  const pairs = Array.from({ length: 10 }, (_, i) => agentIdentity(i)).map((a) => `${a.shape}${a.color}`)
  expect(new Set(pairs).size).toBe(10)
})
