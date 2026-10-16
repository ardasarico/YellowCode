import { expect, test } from "bun:test"
import { cpSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJson } from "../protocol/json.ts"
import { listSessions, readHeadTail, sessionEntry } from "./session-list.ts"

const CWD = "/Users/user/project"

function line(value: object): string {
  return `${JSON.stringify(value)}\n`
}

function reply(length: number): string {
  return line({
    type: "assistant",
    cwd: CWD,
    isSidechain: false,
    message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "x".repeat(length) }] },
  })
}

test("a large file is read as whole lines from its head and tail", async () => {
  const parts = [
    line({ type: "user", cwd: CWD, isSidechain: false, message: { role: "user", content: "First prompt" } }),
  ]
  let size = parts[0]?.length ?? 0
  function add(text: string): number {
    const start = size
    parts.push(text)
    size += text.length
    return start
  }
  while (size < 60_000) add(reply(1000))
  const headLong = add(reply(10_000))
  while (size < 230_000) add(reply(1000))
  const tailLong = add(reply(10_000))
  while (size < 300_000) add(reply(1000))
  add(line({ type: "custom-title", customTitle: "Big session", sessionId: "big" }))
  add(reply(1000))

  expect(headLong).toBeLessThan(64 * 1024)
  expect(headLong + reply(10_000).length).toBeGreaterThan(64 * 1024)
  expect(tailLong).toBeLessThan(size - 64 * 1024)
  expect(tailLong + reply(10_000).length).toBeGreaterThan(size - 64 * 1024)

  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-sessions-")), "big.jsonl")
  writeFileSync(path, parts.join(""))
  const lines = await readHeadTail(path, size)
  for (const text of [...lines.head, ...lines.tail]) expect(parseJson(text).ok).toBe(true)
  expect(sessionEntry(path, lines, 0)).toMatchObject({ title: "Big session", firstPrompt: "First prompt" })
})

test("cwd comes from the tail when the first line is longer than the head", async () => {
  const first = line({ type: "user", cwd: CWD, message: { role: "user", content: "x".repeat(70_000) } })
  const text = first + reply(1000).repeat(100) + line({ type: "last-prompt", lastPrompt: "Last prompt" })
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-sessions-")), "long.jsonl")
  writeFileSync(path, text)
  const lines = await readHeadTail(path, text.length)
  expect(lines.head).toEqual([])
  expect(sessionEntry(path, lines, 0)).toMatchObject({ cwd: CWD, firstPrompt: "Last prompt" })
})

test("a first prompt longer than the head still lists the session under it", async () => {
  const prompt = `Huge ${"x".repeat(300_000)}`
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-sessions-"))
  writeFileSync(
    join(folder, "huge.jsonl"),
    line({ type: "user", cwd: CWD, message: { role: "user", content: prompt } }) + reply(1000).repeat(100),
  )
  expect(await listSessions(folder, CWD)).toMatchObject([{ id: "huge", firstPrompt: prompt }])
})

test("listSessions keeps this project's main sessions, newest first", async () => {
  const copy = join(mkdtempSync(join(tmpdir(), "yellowcode-sessions-")), "-Users-user-project")
  cpSync(join(import.meta.dir, "..", "..", "fixtures", "transcripts", "-Users-user-project"), copy, { recursive: true })
  const order = [
    "bookkeeping",
    "sidechain",
    "other-cwd",
    "d5c8a46f-b0ac-477c-8c59-21998feb2b58",
    "5bb55efd-d4f3-40df-ad48-f7e0593fcf62",
    "8922f31d-e8da-4585-943e-2cf3578aa653",
    "d3d5b4c6-dac7-423d-a75a-8d4ff2e74d03",
    "db7d86ce-8cfe-4027-8b9a-fcf6f34660ca",
    "fb47eef5-11f5-442d-954f-243eb5f4bc61",
  ]
  const now = Date.now() / 1000
  order.forEach((id, k) => utimesSync(join(copy, `${id}.jsonl`), now - k * 60, now - k * 60))

  const expected = [
    "Renamed demo",
    "Counting words",
    "Read notes.txt and reply with its first word.",
    "Reply with the word alpha.",
    "Reply with the word red.",
    "Reply with the number 1.",
  ]
  for (const sessions of [await listSessions(copy, CWD), await listSessions(copy, null)]) {
    expect(sessions.map((session) => session.title)).toEqual(expected)
    expect(sessions.map((session) => session.id)).toEqual(order.slice(3))
  }
})
