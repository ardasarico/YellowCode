import { expect, test } from "bun:test"
import { type DialogSection, filterSections, moveSelection, selectableIds } from "./list.ts"

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

test("a row with search text matches on it instead of its label", () => {
  const rows = [{ id: "a", label: "Fix login", search: "Fix login\nthe token expires early" }]
  expect(selectableIds(filterSections([{ title: "", rows }], "token"))).toEqual(["a"])
})
