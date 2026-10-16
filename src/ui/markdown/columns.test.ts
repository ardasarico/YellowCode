import { expect, test } from "bun:test"
import { parseColumns } from "./columns.ts"

test("columns split on a --- line and keep a fenced code block whole", () => {
  const columns = parseColumns("### Before\n```ts\nconst a = 1\n```\n---\n### After\n- one")
  expect(columns?.map((column) => column.map((entry) => entry.type))).toEqual([
    ["heading", "code"],
    ["heading", "list"],
  ])
  expect(parseColumns("Only one column")).toBeNull()
})

test("a --- line inside fenced code does not split columns", () => {
  const columns = parseColumns("```yaml\nkey: 1\n---\nnext: 2\n```\n---\nright")
  expect(columns?.map((column) => column.map((entry) => entry.type))).toEqual([["code"], ["paragraph"]])
})
