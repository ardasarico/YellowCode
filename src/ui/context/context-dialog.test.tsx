import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ContextReport } from "../../agent/agent.ts"
import { ContextDialog } from "./context-dialog.tsx"

async function frame(used: number) {
  const report: ContextReport = {
    model: "anthropic/claude-opus-5-5",
    used,
    window: 200_000,
    categories: [],
    files: [],
    tools: [],
  }
  const setup = await testRender(
    () => <ContextDialog load={() => Promise.resolve(report)} total="opencode" onClose={() => {}} />,
    { width: 100, height: 20 },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await setup.renderOnce()
  const text = setup.captureCharFrame()
  setup.renderer.destroy()
  return text
}

const cells = (text: string) => ({ full: text.split("█").length - 1, empty: text.split("░").length - 1 })

test("the small /context draws the bar and the total", async () => {
  const empty = await frame(0)
  expect(empty).toContain("Context · anthropic/claude-opus-5-5")
  expect(empty).toContain("0 of 200k tokens used")
  expect(empty).toContain(" 0%")
  expect(empty).toContain("opencode doesn't break this down further.")
  expect(empty).not.toContain("select")
  const bar = cells(empty).empty
  expect(cells(empty).full).toBe(0)

  const part = await frame(84_000)
  expect(part).toContain("84k of 200k tokens used")
  expect(part).toContain("42%")
  expect(cells(part)).toEqual({ full: Math.round(bar * 0.42), empty: bar - Math.round(bar * 0.42) })

  const full = await frame(200_000)
  expect(full).toContain("200k of 200k tokens used")
  expect(full).toContain("100%")
  expect(cells(full)).toEqual({ full: bar, empty: 0 })
})
