import { expect, test } from "bun:test"
import { blendsIn, swatchColor } from "./swatch.ts"

test("colour codes give their colour and names do not", () => {
  expect(swatchColor("#f7a")).toEqual([255, 119, 170])
  expect(swatchColor("rgb(232, 197, 71)")).toEqual([232, 197, 71])
  expect(swatchColor("hsl(230 22% 13%)")).toEqual([26, 28, 40])
  expect(swatchColor("red")).toBeNull()
})

test("a dark colour on a dark background still shows, the background's own colour does not", () => {
  expect(blendsIn([26, 28, 40], [51, 51, 49])).toBe(false)
  expect(blendsIn([51, 51, 49], [51, 51, 49])).toBe(true)
})
