import { expect, test } from "bun:test"
import { atToken, commandLine, completeCommand, highlightRanges, replaceToken, slashQuery } from "./token.ts"

test("slashQuery needs a leading slash and the cursor inside the first token", () => {
  expect(slashQuery("/co", 3)).toBe("co")
  expect(slashQuery("/co foo", 2)).toBe("c")
  expect(slashQuery("/co foo", 5)).toBeNull()
  expect(slashQuery("/co", 0)).toBeNull()
  expect(slashQuery("see /tmp", 8)).toBeNull()
})

test("atToken starts at the text start or after whitespace", () => {
  expect(atToken("fix @pbar now", 9)).toEqual({ start: 4, end: 9, query: "pbar" })
  expect(atToken("@a/b c", 2)).toEqual({ start: 0, end: 4, query: "a" })
  expect(atToken("a@b", 3)).toBeNull()
  expect(atToken("fix @pbar", 4)).toBeNull()
  expect(atToken("x\n@y", 4)).toEqual({ start: 2, end: 4, query: "y" })
})

test("replaceToken swaps the whole token and keeps a folder open", () => {
  const token = { start: 4, end: 9, query: "pb" }
  expect(replaceToken("fix @pbar now", token, "src/a.ts")).toEqual({ text: "fix @src/a.ts now", cursor: 14 })
  expect(replaceToken("fix @pbar", token, "src/a.ts")).toEqual({ text: "fix @src/a.ts ", cursor: 14 })
  expect(replaceToken("fix @pbar", token, "src/ui/")).toEqual({ text: "fix @src/ui/", cursor: 12 })
})

test("a picked command replaces only the first token", () => {
  expect(completeCommand("/co", "compact")).toEqual({ text: "/compact ", cursor: 9 })
  expect(completeCommand("/co foo", "compact")).toEqual({ text: "/compact foo", cursor: 9 })
  expect(commandLine("/co", "compact")).toBe("/compact")
  expect(commandLine("/co foo", "compact")).toBe("/compact foo")
})

test("highlightRanges marks a leading known command and @ tokens after whitespace", () => {
  const commands = [{ name: "compact", description: "", argumentHint: "", aliases: [] }]
  expect(highlightRanges("/compact keep it short", commands)).toEqual([{ start: 0, end: 8 }])
  expect(highlightRanges("/comp x", commands)).toEqual([])
  expect(highlightRanges("see /compact", commands)).toEqual([])
  expect(highlightRanges("fix @src/a.ts please", commands)).toEqual([{ start: 4, end: 13 }])
  expect(highlightRanges("@a\n@b a@c @", commands)).toEqual([
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ])
})
