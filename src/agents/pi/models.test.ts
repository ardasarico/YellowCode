import { expect, test } from "bun:test"
import { levelsOf, modelGroups, readModels } from "./models.ts"

test("a model keeps no endpoint, header or key", () => {
  const read = readModels({
    models: [
      {
        id: "m1",
        name: "Model One",
        provider: "acme",
        baseUrl: "https://example.invalid/v1",
        headers: { "x-key": "secret-value" },
        apiKey: "secret-value",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000,
      },
    ],
  })
  expect(JSON.stringify(read)).not.toContain("secret-value")
  expect(JSON.stringify(read)).not.toContain("example.invalid")
  expect(JSON.stringify(modelGroups(read))).not.toContain("secret-value")
  expect(modelGroups(read)[0]?.models[0]?.window).toBe(1000)
})

test("thinking levels follow the model's level map", () => {
  expect(levelsOf(false, undefined)).toEqual([])
  expect(levelsOf(true, undefined)).toEqual(["off", "minimal", "low", "medium", "high"])
  expect(levelsOf(true, { xhigh: "xhigh", max: "max" })).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(
    levelsOf(true, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }),
  ).toEqual(["low", "medium", "high"])
})
