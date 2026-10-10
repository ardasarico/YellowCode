import { expect, test } from "bun:test"
import { pageLabels } from "./fit.ts"

test("the page bar cuts long headers so it never wraps", () => {
  const headers = ["Storage location for settings", "File formats to support", "Deployment"]
  for (const width of [40, 60, 80]) {
    const bar = `  ${pageLabels(headers, width).join("  │  ")}`
    expect(Bun.stringWidth(bar)).toBeLessThanOrEqual(width)
  }
  expect(pageLabels(["Storage", "Formats"], 60)).toEqual(["1. Storage", "2. Formats", "Submit"])
  expect(pageLabels(["Storage location for settings", "Formats"], 40)[0]).toEndWith("…")
})
