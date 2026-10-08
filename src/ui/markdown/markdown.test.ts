import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "../../protocol/parse.ts"
import { parseRecording } from "../../source/recording.ts"
import { splitBlocks, type Block } from "./blocks.ts"
import { gutterText } from "./code-block.tsx"
import { fitColumns, wrapText } from "./layout.ts"

function longestAssistantText(file: string): string {
  const recording = parseRecording(
    readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "sessions", file), "utf8"),
  )
  let longest = ""
  for (const entry of recording.entries) {
    const parsed = parse(entry.line)
    if (parsed.kind !== "message" || parsed.message.type !== "assistant") continue
    for (const block of parsed.message.message.content) {
      if (block.type === "text" && block.text.length > longest.length) longest = block.text
    }
  }
  return longest
}

test("streaming only ever changes the last block", () => {
  const text = longestAssistantText("long.jsonl")
  let previous: Block[] = []
  for (let end = 40; end < text.length + 40; end += 40) {
    const next = splitBlocks(text.slice(0, end), previous)
    for (let index = 0; index < previous.length - 1; index++) expect(next[index]).toBe(previous[index])
    previous = next
  }
  expect(previous.length).toBeGreaterThan(10)
})

test("columns keep their natural width when they fit", () => {
  expect(fitColumns([["a", "bb"], ["ccc"]], 20)).toEqual([2, 3])
})

test("columns shrink toward their longest word to fit", () => {
  const widths = fitColumns([["name"], ["wraps at word boundaries, never mid-word"]], 30)
  expect(widths.reduce((sum, width) => sum + width, 0)).toBe(30)
  expect(widths[0]).toBe(4)
})

test("only the widest columns break when longest words do not fit", () => {
  expect(fitColumns([["pulldown-cmark"], ["Stars"], ["TypeScript"]], 20)).toEqual([7, 5, 8])
})

test("words longer than the width are broken", () => {
  expect(wrapText("sha256-abcdefghij end", 8)).toEqual(["sha256-a", "bcdefghi", "j end"])
})

test("wrapped code lines get a blank line number", () => {
  expect(gutterText([0, 0, 1], 1)).toBe("1 │\n  │\n2 │")
})
