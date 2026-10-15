import { expect, test } from "bun:test"
import { drawDiagram } from "./diagram.ts"

const steps = (direction: string) =>
  `flowchart ${direction}\n` +
  ["parse args", "read settings", "create renderer", "detect terminal", "load fixture", "render chat"]
    .map((label, index) => `  N${index}[${label}] --> N${index + 1}[step ${index + 1}]`)
    .join("\n")

test("a sideways flowchart that does not fit is drawn top-down", () => {
  const drawing = drawDiagram(steps("LR"), 60, false)
  expect(drawing?.kind).toBe("art")
  expect(drawing?.kind === "art" && drawing.art.width).toBeLessThanOrEqual(60)
  expect(drawDiagram(steps("TD"), 10, false)?.kind).toBe("wide")
})

test("a broken diagram of a known type differs from a type it does not draw", () => {
  const broken = "stateDiagram-v2\n  [*] --> Idle\n  Idle --> --> Busy\n  Busy --> [*]"
  expect(drawDiagram(broken, 80, false)).toEqual({ kind: "broken" })
  expect(drawDiagram(broken, 80, true)).toEqual({ kind: "pending" })
  expect(drawDiagram("gantt\n  title Plan", 80, false)).toBeNull()
})
