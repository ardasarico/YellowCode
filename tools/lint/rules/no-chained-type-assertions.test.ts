import { expect, test } from "bun:test"
import { countReports } from "./lint-cases.ts"

const cases = [
  { code: "const a = b as User", reports: 0 },
  { code: "const a = <User>b", reports: 0 },
  { code: "const a = [1, 2] as const as const", reports: 0 },
  { code: "const a = (b as User).id", reports: 0 },
  { code: "const a = b as unknown as User", reports: 1 },
  { code: "const a = (b as unknown) as User", reports: 1 },
  { code: "const a = <User>(<unknown>b)", reports: 1 },
  { code: "const a = b as unknown as object as User", reports: 1 },
]

test("reports chained type assertions once per chain", async () => {
  const counts = await countReports(
    "no-chained-type-assertions",
    cases.map((sample) => sample.code),
  )

  expect(cases.map((sample, index) => ({ code: sample.code, reports: counts[index] }))).toEqual(cases)
})
