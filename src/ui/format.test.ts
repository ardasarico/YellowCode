import { expect, test } from "bun:test"
import { modelName } from "./format.ts"

test("modelName turns model ids into display names", () => {
  expect(modelName("claude-haiku-5-5")).toBe("Haiku 5.5")
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5")
  expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5")
  expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 [1m]")
  expect(modelName("some-custom-model")).toBe("some-custom-model")
})
