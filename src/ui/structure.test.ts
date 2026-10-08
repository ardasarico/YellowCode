import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "../protocol/parse.ts"
import { createSession } from "../session/session.ts"
import { parseRecording } from "../source/recording.ts"
import { buildRows } from "./structure.ts"

function rowsOf(name: string) {
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    session.apply(entry.dir, parse(entry.line), entry.t)
  const { byId } = session.state
  return buildRows(session.state).map((row) => {
    if (row.kind === "group") return row.items.map((id) => byId[id]?.kind)
    if (row.kind === "end") return `end×${row.turnEnds.length}`
    return row.kind
  })
}

test("consecutive tools fold into one group and a permission splits it", () => {
  expect(rowsOf("tools")).toEqual(["user", "header", ["tool", "tool"], "permission", ["tool"], "markdown", "end×1"])
})

test("an agent gets its own row, and Claude going on after it stays in the same turn", () => {
  expect(rowsOf("subagent")).toEqual(["user", "header", "agent", "markdown", ["thinking"], "markdown", "end×2"])
})
