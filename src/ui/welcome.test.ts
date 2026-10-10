import { expect, test } from "bun:test"
import { welcomeParts } from "./welcome.tsx"

test("welcomeParts drops the recent sessions first, then the wordmark on narrow terminals and the logo on short ones", () => {
  expect(welcomeParts(74, 14, 0)).toEqual({ cat: true, wordmark: true, recent: false })
  expect(welcomeParts(40, 14, 0)).toEqual({ cat: true, wordmark: false, recent: false })
  expect(welcomeParts(74, 13, 0)).toEqual({ cat: false, wordmark: false, recent: false })
  expect([welcomeParts(74, 19, 3).recent, welcomeParts(74, 18, 3).recent]).toEqual([true, false])
})
