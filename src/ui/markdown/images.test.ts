import { expect, test } from "bun:test"
import { Lexer } from "marked"
import { imageLines, markdownImages } from "./images.ts"

test("markdown images resolve local paths and skip web ones", () => {
  const markdown = "![a](shots/a.png) and ![b](/abs/b.jpg)\n\n![logo](https://example.com/logo.png)"
  expect(markdownImages(markdown, "/work")).toEqual([
    { name: "a.png", mediaType: "image/png", data: null, path: "/work/shots/a.png" },
    { name: "b.jpg", mediaType: "image/jpeg", data: null, path: "/abs/b.jpg" },
  ])
})

test("images on one line group together and separate lines stack", () => {
  const [block] = Lexer.lex("![a](a.png) ![b](b.png)\n![c](c.png)", { gfm: true })
  const names = imageLines(block!, "/work").map((line) => line.map((image) => image.name))
  expect(names).toEqual([["a.png", "b.png"], ["c.png"]])
})
