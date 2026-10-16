import { expect, test } from "bun:test"
import { formatSpan, formatTokens, formatUntil, modelName, toolLabel, windowTitle } from "./format.ts"

test("toolLabel splits MCP tool names at the first server boundary", () => {
  expect(toolLabel("mcp__github__list_pull_requests")).toBe("github/list_pull_requests")
  expect(toolLabel("mcp__my_db__run__query")).toBe("my_db/run__query")
  expect(["Read", "mcp__echo", "mcp__echo__", "mcp_x__y"].map(toolLabel)).toEqual([
    "Read",
    "mcp__echo",
    "mcp__echo__",
    "mcp_x__y",
  ])
})

test("modelName turns model ids into display names", () => {
  expect(modelName("claude-haiku-5-5")).toBe("Haiku 5.5")
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5")
  expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5")
  expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 [1m]")
  expect(modelName("some-custom-model")).toBe("some-custom-model")
})

test("formatTokens shortens token counts", () => {
  expect([950, 18_234, 125_400, 1_234_567, 1_000_000].map(formatTokens)).toEqual(["950", "18k", "125k", "1.2M", "1m"])
})

test("formatSpan shows elapsed minutes and hours", () => {
  expect([20_000, 18 * 60_000, 64 * 60_000].map(formatSpan)).toEqual(["<1m", "18m", "1h 4m"])
})

test("formatUntil shows the time left in its two largest units", () => {
  const hour = 3_600_000
  expect([45 * 60_000, 2 * hour + 14 * 60_000, 83 * hour].map(formatUntil)).toEqual(["45m", "2h 14m", "3d 11h"])
})

test("windowTitle drops control characters and stays short", () => {
  expect(windowTitle("\u001b[31mred\u001b[0m\tlog\nline\u0007\u0000\u007f\u0085 end ")).toBe("red log line end")
  expect(windowTitle("x".repeat(6000)).length).toBe(200)
})
