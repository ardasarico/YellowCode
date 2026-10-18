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

const art = (code: string, width = 200) => {
  const drawing = drawDiagram(code, width, false)
  return drawing?.kind === "art" ? drawing.art.plain : []
}

test("an edge that skips ranks goes around the boxes beside it", () => {
  const rows = art(
    "flowchart TD\n  A[User types a prompt] --> B{Slash command?}\n  B -->|yes| C[Run the command]\n" +
      "  B -->|no| D[Send to claude]\n  D --> E[Stream events]\n  E --> F[Render chat]\n  C --> F",
  )
  expect(rows.find((row) => row.includes("Run the command"))).toMatch(/┤ Run the command │ +│ Send to claude │$/)
})

test("parallel edges keep every label", () => {
  const rows = art(
    "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: go\n  Busy --> Idle: result\n  Busy --> Idle: Esc",
  )
  expect(rows.join("\n")).toContain("result / Esc")
})

const fan =
  "flowchart LR\n  UI[YellowCode UI] -->|stream-json| CLI[claude binary]\n  CLI --> API[(Anthropic API)]\n" +
  "  CLI --> MCP[MCP servers]\n  CLI --> Tools[Local tools]"

test("a fan-out leaves its box through one stem", () => {
  const rows = art(fan.replace("LR", "TD"))
  const bottom = rows[rows.findIndex((row) => row.includes("claude binary")) + 1]
  expect(bottom?.match(/[┬┴┼]/g)).toHaveLength(1)
})

test("a sideways flowchart only spends room on the labels each gap holds", () => {
  expect(art(fan, 76).some((row) => row.includes("claude binary ├"))).toBe(true)
})
