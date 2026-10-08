import { expect, test } from "bun:test"
import { diffRows } from "./diff.ts"

test("two changes far apart keep one context line each and a gap between", () => {
  const lines = [" a", "-b", "+B", " c", " d", " e", " f", "+g", " h"]
  const rows = diffRows([{ oldStart: 10, oldLines: 8, newStart: 10, newLines: 9, lines }])
  expect(rows.map((row) => (row.kind === "gap" ? "⋮" : `${row.kind} ${row.number} ${row.text}`))).toEqual([
    "ctx 10 a",
    "del 11 b",
    "add 11 B",
    "ctx 12 c",
    "⋮",
    "ctx 15 f",
    "add 16 g",
    "ctx 17 h",
  ])
})
