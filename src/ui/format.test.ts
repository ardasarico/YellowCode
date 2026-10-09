import { expect, test } from "bun:test"
import { formatSpan, formatTokens, formatUntil, modelName } from "./format.ts"

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
