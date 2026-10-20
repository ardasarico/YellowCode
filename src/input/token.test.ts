import { expect, test } from "bun:test"
import {
  atToken,
  closeFolderQuote,
  commandLine,
  completeCommand,
  highlightRanges,
  replaceToken,
  slashQuery,
} from "./token.ts"

test("slashQuery needs a leading slash and the cursor inside the first token", () => {
  expect(slashQuery("/co", 3)).toBe("co")
  expect(slashQuery("/co foo", 2)).toBe("c")
  expect(slashQuery("/co foo", 5)).toBeNull()
  expect(slashQuery("/co", 0)).toBeNull()
  expect(slashQuery("see /tmp", 8)).toBeNull()
})

test("atToken starts at the text start or after whitespace", () => {
  expect(atToken("fix @pbar now", 9)).toEqual({ start: 4, end: 9, query: "pbar", quoted: false })
  expect(atToken("@a/b c", 2)).toEqual({ start: 0, end: 4, query: "a", quoted: false })
  expect(atToken("a@b", 3)).toBeNull()
  expect(atToken("fix @pbar", 4)).toBeNull()
  expect(atToken("x\n@y", 4)).toEqual({ start: 2, end: 4, query: "y", quoted: false })
})

test("replaceToken swaps the whole token and keeps a folder open", () => {
  const token = { start: 4, end: 9, query: "pb", quoted: false }
  expect(replaceToken("fix @pbar now", token, "src/a.ts")).toEqual({ text: "fix @src/a.ts now", cursor: 14 })
  expect(replaceToken("fix @pbar", token, "src/a.ts")).toEqual({ text: "fix @src/a.ts ", cursor: 14 })
  expect(replaceToken("fix @pbar", token, "src/ui/")).toEqual({ text: "fix @src/ui/", cursor: 12 })
})

test("a quoted mention takes spaces: closed it ends at its quote, unclosed at the first space after the cursor", () => {
  expect(atToken('see @"my fi" now', 11)).toEqual({ start: 4, end: 12, query: "my fi", quoted: true })
  expect(atToken('see @"my fi" now', 12)).toBeNull()
  expect(atToken('see @"my fi now', 11)).toEqual({ start: 4, end: 11, query: "my fi", quoted: true })
})

test("a picked path with a space goes in quoted: a file closes the quote, a folder stays open inside it", () => {
  const typing = { start: 4, end: 10, query: "my f", quoted: true }
  expect(replaceToken('fix @"my f', typing, "src/my file.ts")).toEqual({ text: 'fix @"src/my file.ts" ', cursor: 22 })
  expect(replaceToken('fix @"my f', typing, "Notes Folder/")).toEqual({ text: 'fix @"Notes Folder/', cursor: 19 })
})

test("a space after an open quoted folder closes its quote", () => {
  expect(closeFolderQuote('see @"Notes Folder/ ', 20)).toEqual({ text: 'see @"Notes Folder/" ', cursor: 21 })
  // Typed fast, the next word may already be there.
  expect(closeFolderQuote('see @"Notes Folder/ please', 26)).toEqual({
    text: 'see @"Notes Folder/" please',
    cursor: 27,
  })
  expect(closeFolderQuote('see @"Notes Folder/inner.txt" ', 30)).toBeNull()
  expect(closeFolderQuote("see @src/ ", 10)).toBeNull()
  expect(closeFolderQuote('see @"Notes Fo ', 15)).toBeNull()
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
