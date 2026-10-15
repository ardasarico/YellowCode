import { expect, test } from "bun:test"
import { parseTree } from "./tree.ts"

const lines = (text: string) =>
  parseTree(text)?.map(
    (row) => `${row.prefix}${row.name}${row.folder ? " (folder)" : ""}${row.comment ? ` # ${row.comment}` : ""}`,
  )

test("an indented tree gets connectors, folders and comments", () => {
  expect(lines("src/\n  ui/\n    app.tsx  # entry\n  index.ts")).toEqual([
    "src/ (folder)",
    "├─ ui/ (folder)",
    "│  └─ app.tsx # entry",
    "└─ index.ts",
  ])
})

test("tree output reads the same, and a name with children is a folder", () => {
  expect(lines("src\n├── ui\n│   └── app.tsx\n└── index.ts\n\n1 directory, 2 files")).toEqual([
    "src (folder)",
    "├─ ui (folder)",
    "│  └─ app.tsx",
    "└─ index.ts",
  ])
})

test("an indent that skips a level is not a tree", () => {
  expect(parseTree("src/\n      app.tsx")).toBeNull()
})
