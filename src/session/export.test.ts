import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { conversationMarkdown } from "./export.ts"
import { createSession } from "./session.ts"

test("exports messages, replies and one line per tool call", () => {
  const session = createSession()
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", "tools.jsonl")
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    session.apply(entry.dir, parse(entry.line), entry.t)
  const text = conversationMarkdown(session.state, {
    title: "Port",
    model: "Opus 5.5",
    cwd: "/Users/user/project",
    date: new Date("2026-10-23"),
  })
  expect(text.split("\n").slice(0, 5)).toEqual([
    "# Port",
    "",
    "Exported from YellowCode on 2026-10-23 · Opus 5.5",
    "",
    "## You",
  ])
  expect(text).toContain("- Read(src/config.ts)\n- Edit(src/config.ts) +1 −1\n- Bash(cat src/config.ts)\n\nI changed")
  expect(text).not.toContain("## You\n\n## You")
})
