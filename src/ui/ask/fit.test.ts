import { expect, test } from "bun:test"
import { pageWindow } from "./fit.ts"

const bar = (headers: string[], current: number, width: number) => {
  const { tabs, indicator } = pageWindow(headers, current, [], width)
  return `${tabs.map((tab) => tab.text).join(" | ")}${indicator ? ` (${indicator})` : ""}`
}

test("the page bar cuts long headers first and folds pages only when that is not enough", () => {
  expect(bar(["Storage", "Formats"], 0, 60)).toBe("1. Storage | 2. Formats | Submit")
  expect(pageWindow(["Storage location for settings", "Formats"], 0, [], 40).tabs[0]?.text).toEndWith("…")
  const nine = ["Storage", "Format", "Sync", "Theme", "Font", "Keys", "Sidebar", "Titles", "Updates"]
  expect(bar(nine, 4, 70)).toBe("‹ +4 | 5. Font | 6. Keys | +3 › | Submit (5 of 9)")
  for (const current of [0, 4, 8, 9]) {
    const { tabs, indicator } = pageWindow(nine, current, [], 70)
    const width = 2 + tabs.reduce((sum, tab, i) => sum + Bun.stringWidth(tab.text) + (i ? 5 : 0), 0)
    expect(width + (indicator ? indicator.length + 2 : 0)).toBeLessThanOrEqual(70)
    expect(tabs.some((tab) => tab.page === current)).toBe(true)
  }
})
