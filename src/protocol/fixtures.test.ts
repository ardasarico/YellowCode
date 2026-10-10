import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRecording } from "../source/recording.ts"
import { parse } from "./parse.ts"

const dir = join(import.meta.dir, "..", "..", "fixtures", "sessions")
const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"))

test("all thirteen recordings are present", () => {
  expect(files.toSorted()).toEqual(
    [
      "agents",
      "ask",
      "chat",
      "error",
      "image",
      "long",
      "markdown",
      "mcp",
      "permission-bash",
      "permission",
      "subagent",
      "thinking",
      "tools",
    ].map((name) => `${name}.jsonl`),
  )
})

for (const file of files) {
  test(`${file} parses with no invalid messages`, () => {
    const recording = parseRecording(readFileSync(join(dir, file), "utf8"))
    const invalid = recording.entries.map((entry) => parse(entry.line)).filter((result) => result.kind === "invalid")
    expect(invalid).toEqual([])
  })
}

test("recordings contain no personal data", () => {
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8")
    expect(text).not.toContain("/var/folders")
    expect(text).not.toMatch(/\/Users\/(?!user\b)/)
    expect(text).not.toMatch(/claude-\d+/)
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []
    expect(emails.filter((email) => email !== "user@example.com")).toEqual([])
  }
})
