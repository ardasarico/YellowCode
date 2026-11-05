import { expect, test } from "bun:test"
import { packRow, parseRow } from "./row.ts"

test("a row keeps its non-empty lines and an empty one is no row", () => {
  expect(parseRow("Branch: main\n\n  v0.1.1 \n")).toEqual(["Branch: main", "v0.1.1"])
  expect(parseRow("\n \n")).toBeNull()
})

test("sections wrap only between sections", () => {
  expect(packRow([10, 10, 10], 40)).toEqual([[0, 1, 2]])
  expect(packRow([10, 10, 10], 30)).toEqual([[0, 1], [2]])
  expect(packRow([50, 5], 30)).toEqual([[0], [1]])
})
