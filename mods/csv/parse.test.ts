import { expect, test } from "bun:test"
import { parseRows } from "./parse.ts"

test("quoted fields keep separators, quotes and line breaks", () => {
  expect(parseRows('name,note\n"a, b","say ""hi""\nthere"\nc,d\n', ",")).toEqual([
    ["name", "note"],
    ["a, b", 'say "hi"\nthere'],
    ["c", "d"],
  ])
  expect(parseRows('a,"open', ",")).toBeNull()
})
