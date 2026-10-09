import { expect, test } from "bun:test"
import { welcomeParts } from "./welcome.tsx"

test("welcomeParts drops the wordmark on narrow terminals and the whole logo on short ones", () => {
  expect(welcomeParts(74, 14)).toEqual({ cat: true, wordmark: true })
  expect(welcomeParts(40, 14)).toEqual({ cat: true, wordmark: false })
  expect(welcomeParts(74, 13)).toEqual({ cat: false, wordmark: false })
})
