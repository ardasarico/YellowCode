import { expect, test } from "bun:test"
import { countReports } from "./lint-cases.ts"

const cases = [
  { code: "const value = JSON.parse(text)", reports: 1 },
  { code: "const read = JSON.parse", reports: 1 },
  { code: "const text = JSON.stringify(value)", reports: 0 },
  { code: "const value = parseJson(text)", reports: 0 },
]

test("forbids JSON.parse outside the protocol boundary", async () => {
  const counts = await countReports(
    "no-raw-json-parse",
    cases.map((sample) => sample.code),
  )

  expect(cases.map((sample, index) => ({ code: sample.code, reports: counts[index] }))).toEqual(cases)
})
