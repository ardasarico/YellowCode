import { expect, test } from "bun:test"
import { historyStep } from "./history.ts"

const entries = ["first", "a\nb\nc", "a\nb\nc", "last"]

test("up walks the rows of a recalled entry before going older; down past the newest empties", () => {
  const last = historyStep(entries, null, "up", { row: 0, rows: 1, empty: true })
  expect(last).toEqual({ state: 2, text: "last", cursor: 4 })
  const multi = historyStep(entries, 2, "up", { row: 0, rows: 1, empty: false })
  expect(multi).toEqual({ state: 1, text: "a\nb\nc", cursor: 5 })
  expect(historyStep(entries, 1, "up", { row: 2, rows: 3, empty: false })).toBeNull()
  expect(historyStep(entries, 1, "up", { row: 0, rows: 3, empty: false })?.text).toBe("first")
  expect(historyStep(entries, 1, "down", { row: 1, rows: 3, empty: false })).toBeNull()
  expect(historyStep(entries, 1, "down", { row: 2, rows: 3, empty: false })?.text).toBe("last")
  expect(historyStep(entries, 2, "down", { row: 0, rows: 1, empty: false })).toEqual({
    state: null,
    text: "",
    cursor: 0,
  })
})

test("a draft is never replaced and a scrolled tall entry moves the cursor first", () => {
  expect(historyStep(entries, null, "up", { row: 0, rows: 1, empty: false })).toBeNull()
  expect(historyStep(entries, null, "down", { row: 0, rows: 1, empty: false })).toBeNull()
  expect(historyStep(entries, 1, "up", { row: 2, rows: 8, empty: false })).toBeNull()
})
