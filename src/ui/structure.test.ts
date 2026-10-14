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
  return buildRows(session.state).map((row) => (row.kind === "end" ? `end×${row.turnEnds.length}` : row.kind))
}

test("a turn Claude continues on its own merges into the previous one", () => {
  expect(rowsOf("subagent")).toEqual(["user", "agent", "markdown", "thinking", "markdown", "end×2"])
  expect(rowsOf("agents").filter((row) => row.startsWith("end"))).toEqual(["end×4"])
})

test("a workflow call is one agent row", () => {
  expect(rowsOf("workflow").filter((row) => row === "agent")).toHaveLength(1)
})
