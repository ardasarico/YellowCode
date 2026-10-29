import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { feed } from "../agents/claude/translate.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { conversationMarkdown, freeExportName } from "./export.ts"
import { createSession } from "./session.ts"

test("a default export name skips the files already there", () => {
  const dir = mkdtempSync(join(tmpdir(), "yc-export-"))
  expect(freeExportName(dir, "a.md")).toBe("a.md")
  writeFileSync(join(dir, "a.md"), "")
  writeFileSync(join(dir, "a-2.md"), "")
  expect(freeExportName(dir, "a.md")).toBe("a-3.md")
})

test("exports messages, replies and one line per tool call", () => {
  const session = createSession()
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", "tools.jsonl")
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
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

test("a failed tool call carries the last lines of its output", () => {
  const session = createSession()
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", "tools.jsonl")
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
  const { byId } = session.state
  const failed = Object.fromEntries(
    Object.entries(byId).map(([id, item]) => [
      id,
      item.kind === "tool" && item.name === "Bash"
        ? {
            ...item,
            status: "error" as const,
            result: Array.from({ length: 12 }, (_, n) => `line ${n + 1} /Users/user/project/a.ts`).join("\n"),
          }
        : item,
    ]),
  )
  const text = conversationMarkdown(
    { ...session.state, byId: failed },
    {
      title: "Port",
      model: "",
      cwd: "/Users/user/project",
      date: new Date("2026-10-23"),
    },
  )
  expect(text).toContain("· failed\n```\nline 5 a.ts\n")
  expect(text).toContain("line 12 a.ts\n```")
  expect(text).not.toContain("line 4 ")
})
