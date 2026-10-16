import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Lexer } from "marked"
import { imageLines, markdownImages, readLocalImage } from "./images.ts"

test("markdown images resolve local paths and skip web ones", () => {
  const markdown = "![a](shots/a.png) and ![b](/abs/b.jpg) ![c](~/c.png)\n\n![logo](https://example.com/logo.png)"
  expect(markdownImages(markdown, "/work")).toEqual([
    { name: "a.png", mediaType: "image/png", data: null, path: "/work/shots/a.png" },
    { name: "b.jpg", mediaType: "image/jpeg", data: null, path: "/abs/b.jpg" },
    { name: "c.png", mediaType: "image/png", data: null, path: join(homedir(), "c.png") },
  ])
})

test("images on one line group together and separate lines stack", () => {
  const [block] = Lexer.lex("![a](a.png) ![b](b.png)\n![c](c.png)", { gfm: true })
  const names = imageLines(block!, "/work").map((line) => line.map((image) => image.name))
  expect(names).toEqual([["a.png", "b.png"], ["c.png"]])
})

test("only regular files of a sane size are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "yc-images-"))
  writeFileSync(join(dir, "small.png"), "png")
  writeFileSync(join(dir, "huge.png"), "")
  truncateSync(join(dir, "huge.png"), 21 * 1024 * 1024)
  expect(readLocalImage(join(dir, "small.png"))?.toString()).toBe("png")
  expect(readLocalImage(join(dir, "huge.png"))).toBeNull()
  expect(readLocalImage(dir)).toBeNull()
  expect(readLocalImage("/dev/null")).toBeNull()
  expect(readLocalImage(join(dir, "missing.png"))).toBeNull()
  rmSync(dir, { recursive: true })
})
