import { expect, test } from "bun:test"
import { DAY, parseGantt } from "./gantt.ts"

test("gantt tasks follow ids, after-links and durations", () => {
  const gantt = parseGantt(
    [
      "gantt",
      "  title Plan",
      "  dateFormat YYYY-MM-DD",
      "  section Build",
      "  Parser   :done, p1, 2026-10-12, 3d",
      "  Renderer :after p1, 1w",
      "  Review   :2d",
      "  Release  :milestone, 2026-11-02, 0d",
    ].join("\n"),
  )
  const start = Date.UTC(2026, 9, 12)
  expect(gantt?.title).toBe("Plan")
  expect(gantt?.tasks.map((task) => [task.name, (task.start - start) / DAY, (task.end - start) / DAY])).toEqual([
    ["Parser", 0, 3],
    ["Renderer", 3, 10],
    ["Review", 10, 12],
    ["Release", 21, 21],
  ])
  expect(gantt?.tasks[0]?.tags).toEqual(["done"])
})
