import { expect, test } from "bun:test"
import { ganttGuides } from "./diagram-view.tsx"
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

test("gantt guides step up from weeks to calendar months and years as the span grows", () => {
  const first = Date.UTC(2026, 9, 1)
  const labels = (days: number) => ganttGuides(first, first + days * DAY, 42).map((guide) => guide.label)
  expect(labels(21)).toEqual(["Oct 1", "Oct 8", "Oct 15", "Oct 22"])
  expect(labels(700)).toEqual(["Jan '27", "Jul '27", "Jan '28", "Jul '28"])
  expect(labels(365 * 31)).toEqual(["2030", "2035", "2040", "2045", "2050", "2055"])
  expect(labels(7_000_000)).toEqual(["5000", "10000", "15000", "20000"])
})
