import { expect, test } from "bun:test"
import { type DialogSection, dialogLines, filterSections, moveSelection, scrollWindow, selectableIds } from "./list.ts"

const sections: DialogSection[] = [
  {
    title: "Appearance",
    rows: [
      { id: "theme", label: "Theme" },
      { id: "sidebar", label: "Sidebar" },
    ],
  },
  { title: "Session", rows: [{ id: "title", label: "Session title" }] },
]

test("a step down from the last row of a section lands on the first row of the next", () => {
  expect(moveSelection(selectableIds(sections), "sidebar", 1)).toBe("title")
})

test("a scrolled list keeps the selection in view and counts the rows its more lines hide", () => {
  const lines = dialogLines(
    [
      { title: "A", rows: ["a1", "a2", "a3"].map((id) => ({ id, label: id })) },
      { title: "B", rows: ["b1", "b2", "b3"].map((id) => ({ id, label: id })) },
    ],
    undefined,
  )
  // title, 3 rows, gap, title, 3 rows: nine lines in five rows.
  const top = scrollWindow(lines, 5, 0, 1, 0)
  expect([top.start, top.end, top.above, top.below]).toEqual([0, 4, 0, 3])
  const bottom = scrollWindow(lines, 5, 8, 8, top.start)
  expect([bottom.start, bottom.end, bottom.above, bottom.below]).toEqual([5, 9, 3, 0])
  const back = scrollWindow(lines, 5, 7, 7, bottom.start)
  expect(back.start).toBe(bottom.start)
})

test("a row with search text matches on it instead of its label", () => {
  const rows = [{ id: "a", label: "Fix login", search: "Fix login\nthe token expires early" }]
  expect(selectableIds(filterSections([{ title: "", rows }], "token"))).toEqual(["a"])
})
