import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRecording } from "../source/recording.ts"
import { parse } from "./parse.ts"

const dir = join(import.meta.dir, "..", "..", "fixtures", "sessions")
const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"))
const transcriptsDir = join(import.meta.dir, "..", "..", "fixtures", "transcripts")
const transcripts = readdirSync(transcriptsDir, { recursive: true, withFileTypes: true }).filter((entry) =>
  entry.isFile(),
)

test("all twenty recordings are present", () => {
  expect(files.toSorted()).toEqual(
    [
      "agent-shell",
      "agents",
      "ask",
      "background-bash",
      "chat",
      "commands",
      "error",
      "image",
      "long",
      "markdown",
      "mcp-states",
      "mcp",
      "nested-agents",
      "permission-bash",
      "permission",
      "shells",
      "subagent",
      "thinking",
      "tools",
      "workflow",
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

function expectNoPersonalData(text: string): void {
  expect(text).not.toContain("/var/folders")
  expect(text).not.toMatch(/\/Users\/(?!user\b)/)
  expect(text).not.toMatch(/claude-\d+/)
  const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []
  expect(emails.filter((email) => email !== "user@example.com")).toEqual([])
}

test("recordings contain no personal data", () => {
  for (const file of files) expectNoPersonalData(readFileSync(join(dir, file), "utf8"))
})

test("transcripts contain no personal data", () => {
  for (const entry of transcripts) {
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8")
    expectNoPersonalData(text)
    expect(text).not.toContain("/private/tmp")
  }
})
