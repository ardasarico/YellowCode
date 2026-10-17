import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseRef, textParts } from "./refs.ts"

const cwd = process.cwd()
const app = resolve(cwd, "src/ui/app.tsx")

test("parseRef reads lines, ranges and anchors of existing files only", () => {
  expect(parseRef("src/ui/app.tsx:182", cwd)).toEqual({ path: app, line: 182 })
  expect(parseRef("src/ui/app.tsx:182-195", cwd)).toEqual({ path: app, line: 182, end: 195 })
  expect(parseRef("src/ui/app.tsx#L197", cwd)).toEqual({ path: app, line: 197 })
  expect(parseRef("src/ui/app.tsx", cwd)).toEqual({ path: app })
  expect(parseRef("src/ui", cwd)).toBeNull()
  expect(parseRef("src/ui/missing.tsx:3", cwd)).toBeNull()
})

test("textParts keeps punctuation out of refs and finds image mentions", () => {
  const parts = textParts("See src/ui/app.tsx:5. Compare [Image 2].", cwd, 2)
  expect(parts.filter((part) => part.target).map((part) => part.text)).toEqual(["src/ui/app.tsx:5", "[Image 2]"])
  expect(parts.map((part) => part.text).join("")).toBe("See src/ui/app.tsx:5. Compare [Image 2].")
  expect(textParts("[Image 0]", cwd, 2).some((part) => part.target)).toBe(false)
  expect(textParts("[Image 3]", cwd, 2).some((part) => part.target)).toBe(false)
})
