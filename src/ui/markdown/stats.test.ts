import { expect, test } from "bun:test"
import { parseStats } from "./stats.ts"

test("a stat keeps its note and takes its colour from a hidden good or bad mark", () => {
  expect(parseStats("Bundle: 412 KB (-18 KB, good)\nFiles: 96\nStart: 12:30")).toEqual([
    { label: "Bundle", value: "412 KB", note: "-18 KB", tone: "good" },
    { label: "Files", value: "96" },
    { label: "Start", value: "12:30" },
  ])
})

test("one line that is not a stat turns the block back into code", () => {
  expect(parseStats("Tests passed\nCoverage: 87%")).toBeNull()
})
