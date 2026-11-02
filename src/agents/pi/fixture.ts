// The format of fixtures/pi/*.jsonl, written by tools/pi/record.ts.
import { z } from "zod"
import { parseJson } from "../../json.ts"

const metaLine = z.looseObject({ kind: z.literal("meta"), scenario: z.string(), pi: z.string(), root: z.string() })
const intentLine = z.looseObject({
  kind: z.literal("intent"),
  n: z.number(),
  intent: z.string(),
  args: z.unknown().optional(),
})
// A command or answer we sent; `n` counts the messages sent before it.
const outLine = z.looseObject({ kind: z.literal("out"), n: z.number(), t: z.number(), msg: z.unknown() })
// A line from pi; `after` is how many messages we had sent when it arrived.
const inLine = z.looseObject({ kind: z.literal("in"), t: z.number(), after: z.number(), msg: z.unknown() })
// pi exited on its own during the recording.
const exitLine = z.looseObject({
  kind: z.literal("exit"),
  t: z.number(),
  after: z.number(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
})

const line = z.discriminatedUnion("kind", [metaLine, intentLine, outLine, inLine, exitLine])

export type FixtureLine = z.output<typeof line>
export type Fixture = { meta: z.output<typeof metaLine>; lines: FixtureLine[] }

export function readFixture(text: string): Fixture {
  const lines = text
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row, index) => {
      const json = parseJson(row)
      const parsed = json.ok ? line.safeParse(json.value) : undefined
      if (!parsed?.success) throw new Error(`fixture line ${index + 1} is not a fixture line`)
      return parsed.data
    })
  const meta = lines[0]
  if (meta?.kind !== "meta") throw new Error("a fixture starts with its meta line")
  return { meta, lines }
}
