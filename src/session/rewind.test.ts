import { expect, test } from "bun:test"
import { type FileChange, mergeChanges } from "./rewind.ts"

const change = (path: string, plus: number, minus: number, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  plus,
  minus,
  created: false,
  bash: false,
  conflict: false,
  ...extra,
})

test("mergeChanges sums a path across edits and keeps the first edit's created flag", () => {
  const merged = mergeChanges([
    change("a.ts", 3, 0, { created: true }),
    change("b.ts", 1, 1),
    change("a.ts", 2, 1, { bash: true }),
  ])
  expect(merged).toEqual([change("a.ts", 5, 1, { created: true, bash: true }), change("b.ts", 1, 1)])
})
