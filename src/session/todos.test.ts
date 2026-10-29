import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { feed } from "../agents/claude/translate.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { createSession } from "./session.ts"
import { todoChange, todoList } from "./todos.ts"

test("follows Claude's task list and says what each call changed", () => {
  const session = createSession()
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", "tasks.jsonl")
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
  expect(todoList(session.state).map((todo) => `${todo.id} ${todo.state} ${todo.text}`)).toEqual([
    "1 done Write the parser",
    "2 active Add tests",
  ])
  const changes = ["toolu_mock0000", "toolu_mock0001", "toolu_mock0002", "toolu_mock0003", "toolu_mock0004"].map((id) =>
    todoChange(session.state, id),
  )
  expect(changes).toEqual([
    null,
    { kind: "planned", count: 2 },
    { kind: "started", text: "Write the parser", more: 0 },
    null,
    { kind: "finished", text: "Write the parser", more: 0 },
  ])
})
