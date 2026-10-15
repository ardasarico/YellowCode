import { expect, test } from "bun:test"
import { swatchColor } from "./swatch.ts"

test("colour codes give their colour and names do not", () => {
  expect(swatchColor("#f7a")).toEqual([255, 119, 170])
  expect(swatchColor("rgb(232, 197, 71)")).toEqual([232, 197, 71])
  expect(swatchColor("hsl(230 22% 13%)")).toEqual([26, 28, 40])
  expect(swatchColor("red")).toBeNull()
})
