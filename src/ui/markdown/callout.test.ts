import { expect, test } from "bun:test"
import { Lexer, type Token } from "marked"
import { calloutOf } from "./callout.ts"

const first = (markdown: string): Token => Lexer.lex(markdown, { gfm: true })[0]!

test("a GitHub alert is a callout and a plain quote is not", () => {
  const callout = calloutOf(first("> [!warning]\n> Mind the gap."))
  expect(callout?.kind).toBe("warning")
  expect(callout?.tokens[0]?.raw).toBe("Mind the gap.")
  expect(calloutOf(first("> Just a quote."))).toBeNull()
})
