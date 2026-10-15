import { expect, test } from "bun:test"
import { mathSpans, toUnicode } from "./math.ts"

test("prices are not maths", () => {
  expect(mathSpans("costs $5 and $10 per seat")).toEqual([{ text: "costs $5 and $10 per seat", math: false }])
})

test("a formula turns into unicode", () => {
  expect(toUnicode(String.raw`E = \frac{1}{n} \sum_{i=1}^{n} (y_i - \hat{y}_i)^2`)).toBe("E = (1/n) ∑ᵢ₌₁ⁿ (yᵢ - ŷᵢ)²")
})
