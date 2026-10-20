import { expect, test } from "bun:test"
import { cutStep, LABEL_EXTRA, matrixColumns, pageWindow, STEP_EXTRA, wrapRows } from "./fit.ts"

const bar = (headers: string[], current: number, width: number) => {
  const { tabs, indicator } = pageWindow(headers, current, [], width)
  return `${tabs.map((tab) => tab.text).join(" | ")}${indicator ? ` (${indicator})` : ""}`
}

test("the page bar cuts long headers first and folds pages only when that is not enough", () => {
  expect(bar(["Storage", "Formats"], 0, 60)).toBe("Storage | Formats | Submit (1 of 2)")
  expect(pageWindow(["Storage location for settings", "Formats"], 0, [], 40).tabs[0]?.text).toEndWith("…")
  const nine = ["Storage", "Format", "Sync", "Theme", "Font", "Keys", "Sidebar", "Titles", "Updates"]
  expect(bar(nine, 4, 70)).toBe("‹ +3 | Theme | Font | Keys | Sidebar | +2 › | Submit (5 of 9)")
  expect(bar(nine, 4, 30)).toBe("‹ +4 | Font | +4 › | Submit")
  for (const current of [0, 4, 8, 9]) {
    const { tabs, indicator } = pageWindow(nine, current, [], 70)
    const width = 2 + tabs.reduce((sum, tab, i) => sum + Bun.stringWidth(tab.text) + 2 + (i ? 1 : 0), 0)
    expect(width + (indicator ? indicator.length + 2 : 0)).toBeLessThanOrEqual(70)
    expect(tabs.some((tab) => tab.page === current)).toBe(true)
  }
})

test("wrapped rows stop at the cap with an ellipsis and break words wider than a row", () => {
  expect(wrapRows("one two three four five", 9, 2)).toEqual(["one two", "three fo…"])
  expect(wrapRows("one two", 9, 2, 6)).toEqual(["one", "two"])
  expect(wrapRows("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
})

test("a matrix fits its width: labels keep 16 cells (less when shorter), then all steps but the cursor's are cut", () => {
  expect(matrixColumns(["Theme", "Effort"], ["Yes", "No"], 80)).toEqual({
    label: 6,
    limits: [Infinity, Infinity],
    cursorLimit: Infinity,
  })
  const scale = ["Definitely yes", "Probably yes", "Probably not", "Definitely not"]
  const { label, limits, cursorLimit } = matrixColumns(["Dark mode", "Offline sync"], scale, 70)
  expect(label).toBe(12)
  for (const cursor of [0, 1, 2, 3]) {
    const steps = scale.map((step, at) => cutStep(step, at === cursor ? cursorLimit : (limits[at] ?? 0)))
    expect(steps[cursor]).toBe(scale[cursor])
    const width = steps.reduce((sum, step) => sum + Bun.stringWidth(step) + STEP_EXTRA, LABEL_EXTRA + label)
    expect(width).toBeLessThanOrEqual(70)
  }
  const rows = Array.from({ length: 60 }, (_, index) => `Row number ${index + 1}`)
  const wide = matrixColumns(rows, scale, 78).limits
  expect(scale.map((step, at) => cutStep(step, wide[at] ?? 0))).toEqual([
    "Definitely…",
    "Probably y…",
    "Probably…",
    "Definitely…",
  ])
})
