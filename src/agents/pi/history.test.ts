import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { historyEvents } from "./history.ts"
import { promptMap } from "./prompts.ts"
import type { Entry } from "./sessions.ts"

const dir = mkdtempSync(join(tmpdir(), "yc-pi-history-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const user = (id: string, parentId: string | null, text: string): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
})
const answer = (id: string, parentId: string, text: string): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 },
})

// A session that went back to before b1 and on with c1: the file still holds b1, off the branch.
const entries = [
  user("a1", null, "ONE"),
  answer("a2", "a1", "First."),
  user("b1", "a2", "TWO"),
  answer("b2", "b1", "Second."),
  user("c1", "a2", "THREE"),
  answer("c2", "c1", "Third."),
]

test("history follows the branch the session is on and gives back our prompt ids", () => {
  const prompts = promptMap(dir)
  prompts.add("s1", [
    ["a1", "prompt-a"],
    ["b1", "prompt-b"],
  ])
  prompts.add("s1", [["c1", "prompt-c"]])
  const users = historyEvents(entries, prompts.read("s1"), "/project").flatMap((event) =>
    event.type === "user" ? [[event.prompt, event.text, event.cutPoint]] : [],
  )
  expect(users).toEqual([
    ["prompt-a", "ONE", true],
    ["prompt-c", "THREE", true],
  ])
})

test("a message with no prompt id of ours keeps pi's entry id, and a bad session id keeps nothing", () => {
  const users = historyEvents(entries, new Map(), "/project").flatMap((event) =>
    event.type === "user" ? [event.prompt] : [],
  )
  expect(users).toEqual(["a1", "c1"])
  const prompts = promptMap(dir)
  prompts.add("../escape", [["a1", "x"]])
  expect(prompts.read("../escape").size).toBe(0)
})
