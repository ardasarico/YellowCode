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
