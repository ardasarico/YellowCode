import { expect, test } from "bun:test"
import { searchEntries, withFolders } from "./files.ts"

const entries = withFolders([
  "package.json",
  "src/index.tsx",
  "src/ui/ask/ask-row.tsx",
  "src/ui/prompt-bar.tsx",
  "src/ui/probe/bar.ts",
  "docs/p/b/a/r.md",
])

test("withFolders adds every parent folder", () => {
  expect(entries).toContain("src/ui/ask/")
  expect(entries).toContain("src/")
})

test("empty and folder queries list direct children", () => {
  expect(searchEntries(entries, "")).toEqual(["docs/", "package.json", "src/"])
  expect(searchEntries(entries, "src/ui/")).toEqual(["src/ui/ask/", "src/ui/probe/", "src/ui/prompt-bar.tsx"])
})

test("fuzzy queries rank last-segment matches, then fewer gaps, then shorter paths", () => {
  expect(searchEntries(entries, "pbar")).toEqual(["src/ui/prompt-bar.tsx", "src/ui/probe/bar.ts", "docs/p/b/a/r.md"])
  expect(searchEntries(entries, "UI/ASK")[0]).toBe("src/ui/ask/")
})
