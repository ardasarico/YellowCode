import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { isDark, tintsFrom } from "./palette.ts"

const colors = (background: string | null): TerminalColors => ({
  palette: [null, "#ff0000", "#00ff00", "#ffff00"],
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

test("a terminal without a background color gets no tints and counts as dark", () => {
  expect(tintsFrom(colors(null))).toBeNull()
  expect(isDark(null)).toBe(true)
  expect(isDark("#f6efe0")).toBe(false)
})
