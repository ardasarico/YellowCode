import { expect, test } from "bun:test"
import { reportMarkdown, scrub, settingsFacts } from "./report.ts"
import { DEFAULT_SETTINGS } from "./session/settings-file.ts"

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

test("each agent's saved mode goes under its name", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    defaultAgent: "claude",
    agents: { claude: { defaultMode: "plan" }, other: { defaultMode: "build" }, gone: { defaultMode: "ask" } },
  }
  const plan = { id: "plan", label: "Plan", description: "", kind: "plan" as const, cycle: true }
  const modes = [{ ...plan, available: true, group: null }]
  const names = [
    { id: "claude", name: "Claude Code" },
    { id: "other", name: "Other" },
  ]
  const rows = settingsFacts(settings, { id: "claude", name: "Claude Code", modes }, names, null)
  expect(rows).toContainEqual(["Claude Code mode", "Plan"])
  expect(rows).toContainEqual(["Other mode", "build"])
  expect(rows).toContainEqual(["gone mode", "ask"])
  expect(rows).toContainEqual(["Default agent", "Claude Code"])
})
