import { expect, test } from "bun:test"
import { measureEditText } from "@opentui/core"
import { type Draft, draftFromMessage, expandDraft, imagePath, stringIndexes, toBufferOffset } from "./draft.ts"

const measure = (text: string) => measureEditText(text, { widthMethod: "unicode" })
const image = { mediaType: "image/png" as const, base64: "AAAA" }

test("expandDraft replaces chips by range and renumbers images", () => {
  const text = "a [Pasted text 1 +1 line] b [Pasted text 1]"
  const pasted: Draft = { text, chips: [{ start: 2, end: 25, chip: { kind: "text", n: 1, content: "x\ny" } }] }
  expect(expandDraft(pasted)).toEqual({ text: "a x\ny b [Pasted text 1]", images: [] })

  const second: Draft = { text: "see [Image 2]", chips: [{ start: 4, end: 13, chip: { kind: "image", n: 2, image } }] }
  expect(expandDraft(second)).toEqual({ text: "see [Image 1]", images: [image] })
})

test("a recalled message keeps every image in its number", () => {
  const images = [
    { name: "a", mediaType: "image/png", data: "AA", path: null },
    { name: "b", mediaType: "image/png", data: "BB", path: null },
  ]
  const draft = draftFromMessage("[Image 1] hi", images)
  expect(draft.text).toBe("[Image 1] hi [Image 2]")
  expect(expandDraft(draft)).toEqual({
    text: "[Image 1] hi [Image 2]",
    images: [
      { mediaType: "image/png", base64: "AA" },
      { mediaType: "image/png", base64: "BB" },
    ],
  })
})

test("imagePath accepts one escaped or quoted image path", () => {
  expect(imagePath("/a/shot\\ \\(1\\).png")).toBe("/a/shot (1).png")
  expect(imagePath("'/a/b c.JPG'\n")).toBe("/a/b c.JPG")
  expect(imagePath("/a/one.png\n/a/two.png")).toBeNull()
  expect(imagePath("/a/notes.txt")).toBeNull()
})

test("buffer offsets round-trip over wide characters, tabs and newlines", () => {
  const text = "ğ日\tx\n[Pasted text 1 +3 lines]"
  const indexes = [0, 1, 2, 3, 4, 5, text.length]
  const offsets = indexes.map((index) => toBufferOffset(text, index, measure))
  expect(offsets).toEqual([0, 1, 3, 5, 6, 7, 31])
  const at = stringIndexes(text, measure)
  expect(offsets.map(at)).toEqual(indexes)
})
