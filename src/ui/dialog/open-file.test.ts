import { expect, test } from "bun:test"
import { editorUrl } from "./open-file.ts"

test("editor links escape spaces, # and ? in the path", () => {
  expect(editorUrl("zed", "/work/my notes/#1?.ts", 12)).toBe("zed://file/work/my%20notes/%231%3F.ts:12")
  expect(editorUrl("vscode", "/work/a.ts")).toBe("vscode://file/work/a.ts")
})
