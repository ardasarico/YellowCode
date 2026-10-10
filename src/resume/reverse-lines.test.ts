import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLinesBackward } from "./reverse-lines.ts"

const LINES = [
  "start ş",
  `${"ş".repeat(40)} long line`,
  "short 🙂",
  `${"ğ🙂".repeat(20)} end`,
  "x",
  `${"🙂".repeat(30)}ğ`,
]

async function readAll(path: string, end: number) {
  const lines = []
  for await (const line of readLinesBackward(path, end, 64)) lines.push(line)
  return lines
}

test("lines come back whole, newest first, with their byte offsets", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-lines-")), "lines.jsonl")
  const text = LINES.map((line) => `${line}\n`).join("")
  writeFileSync(path, text)
  const expected = LINES.map((line, index) => ({
    line,
    offset: Buffer.byteLength(
      LINES.slice(0, index)
        .map((before) => `${before}\n`)
        .join(""),
    ),
  })).toReversed()

  expect(await readAll(path, Buffer.byteLength(text))).toEqual(expected)

  const middle = expected[2]?.offset ?? 0
  expect(await readAll(path, middle)).toEqual(expected.slice(3))
})
