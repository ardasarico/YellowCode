import { expect, test } from "bun:test"
import { cut, formatTokens, modelName, pad, printable, windowTitle } from "./format.ts"

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

test("windowTitle drops control characters and stays short", () => {
  expect(windowTitle("\u001b[31mred\u001b[0m\tlog\nline\u0007\u0000\u007f\u0085 end ")).toBe("red log line end")
  expect(windowTitle("x".repeat(6000)).length).toBe(200)
})

test("cut leaves nothing when not even the ellipsis fits", () => {
  expect([cut("abc", 0), cut("abc", -2), cut("abc", 1), cut("abc", 2)]).toEqual(["", "", "…", "a…"])
})

test("printable drops escape sequences and control characters but keeps newlines and tabs", () => {
  expect(printable("\u001b[31merror\u001b[0m:\tfailed\r\n\u0007done")).toBe("error:\tfailed\ndone")
})

test("pad and cut count display columns", () => {
  expect(Bun.stringWidth(pad("🍎 Apple", 10))).toBe(10)
  expect(Bun.stringWidth(pad("日本語", 10))).toBe(10)
  expect(pad("日本語", 4)).toBe("日本語")
  expect(cut("日本語", 5)).toBe("日本…")
  expect(cut("🍎 Apple", 4)).toBe("🍎 …")
})

test("cut turns line breaks into spaces", () => {
  expect(cut("a\nb", 10)).toBe("a b")
})
