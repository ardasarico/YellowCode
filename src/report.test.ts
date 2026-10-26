import { expect, test } from "bun:test"
import { reportMarkdown, scrub } from "./report.ts"

test("a report hides the home folder and the user name, and leaves a short name alone", () => {
  expect(scrub("/Users/someone/code/app.ts by someone", "/Users/someone", "someone")).toBe("~/code/app.ts by user")
  expect(scrub("a bat and a cat", "/home/a", "a")).toBe("a bat and a cat")
})

test("a row with no value is left out", () => {
  const text = reportMarkdown({
    environment: [
      ["Bun", "1.4.3"],
      ["Device", null],
    ],
    settings: [],
    log: [],
  })
  expect(text).toContain("Bun")
  expect(text).not.toContain("Device")
})
