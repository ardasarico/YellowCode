import { expect, test } from "bun:test"
import { countReports } from "./lint-cases.ts"

const cases = [
  { code: "const a = [1, 2] as const", reports: 0 },
  { code: "// SAFETY: the parser only emits users here\nconst a = b as User", reports: 0 },
  { code: "const a = b as User // SAFETY: the parser only emits users here", reports: 0 },
  { code: "/* SAFETY: checked above */\nconst a = <User>b", reports: 0 },
  { code: "const a = b as User", reports: 1 },
  { code: "// the parser only emits users here\nconst a = b as User", reports: 1 },
  { code: "// SAFETY:\nconst a = b as User", reports: 1 },
  { code: "// SAFETY: too far away\n\nconst a = b as User", reports: 1 },
  { code: "const a = <User>b", reports: 1 },
]

test("requires a SAFETY comment next to each type assertion", async () => {
  const counts = await countReports(
    "require-assertion-comment",
    cases.map((sample) => sample.code),
  )

  expect(cases.map((sample, index) => ({ code: sample.code, reports: counts[index] }))).toEqual(cases)
})
