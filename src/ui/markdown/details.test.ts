import { expect, test } from "bun:test"
import { Lexer } from "marked"
import { groupDetails } from "./details.ts"

const lex = (markdown: string) => Lexer.lex(markdown, { gfm: true }).filter((token) => token.type !== "space")

test("a details section becomes one entry", () => {
  const entries = groupDetails(lex("<details><summary>Notes</summary>\n\nOne\ntwo\n\n</details>\n\nAfter"))
  expect(entries.map((entry) => entry.type)).toEqual(["details", "paragraph"])
  expect(entries[0]).toMatchObject({ summary: "Notes", lines: 2 })
})

test("an unclosed details section stays plain", () => {
  const entries = groupDetails(lex("<details><summary>Notes</summary>\n\nOne"))
  expect(entries.map((entry) => entry.type)).toEqual(["html", "paragraph"])
})
