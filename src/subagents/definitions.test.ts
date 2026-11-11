import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../log/log.ts"
import { globalFolder, loadDefinitions, projectFolder, writeModel } from "./definitions.ts"

let cwd = ""
const savedConfig = process.env["YELLOWCODE_HOME"]

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "yellowcode-agents-"))
  process.env["YELLOWCODE_HOME"] = join(root, "home")
  cwd = join(root, "project")
  mkdirSync(globalFolder(), { recursive: true })
  mkdirSync(projectFolder(cwd), { recursive: true })
})

afterEach(() => {
  if (savedConfig === undefined) delete process.env["YELLOWCODE_HOME"]
  else process.env["YELLOWCODE_HOME"] = savedConfig
})

const added = (provider: string, model: string) => provider === "opencode" && model === "openrouter/deepseek-v4"

test("project wins over global, global over built-in, and unknown keys are ignored", () => {
  writeFileSync(join(globalFolder(), "explore.md"), "---\ndescription: global explore\nprovider: claude\n---\nglobal")
  writeFileSync(join(globalFolder(), "reviewer.md"), "---\ndescription: global reviewer\n---\nglobal")
  writeFileSync(
    join(projectFolder(cwd), "reviewer.md"),
    "---\ndescription: project reviewer\nprovider: opencode\nmodel: openrouter/deepseek-v4\ncolor: red\n---\nReview it.",
  )
  const definitions = loadDefinitions(cwd, added)
  const explore = definitions.find((entry) => entry.name === "explore")
  const reviewer = definitions.find((entry) => entry.name === "reviewer")
  expect(explore).toMatchObject({ source: "global", description: "global explore", permissions: "inherit" })
  expect(reviewer).toMatchObject({
    source: "project",
    description: "project reviewer",
    instructions: "Review it.",
    plugins: false,
    active: true,
  })
  expect(definitions.find((entry) => entry.name === "worker")).toMatchObject({ source: "built-in", active: false })
})

test("a malformed file is skipped with a log line", () => {
  const warn = spyOn(log, "warn")
  writeFileSync(join(projectFolder(cwd), "worker.md"), "---\npermissions: everything\n---\nbody")
  writeFileSync(join(projectFolder(cwd), "broken.md"), "---\ndescription: [unclosed\n---\nbody")
  const definitions = loadDefinitions(cwd, added)
  expect(definitions.find((entry) => entry.name === "worker")?.source).toBe("built-in")
  expect(definitions.some((entry) => entry.name === "broken")).toBe(false)
  expect(warn.mock.calls.map((call) => call[0])).toEqual([
    `agent file skipped: ${join(projectFolder(cwd), "broken.md")}`,
    `agent file skipped: ${join(projectFolder(cwd), "worker.md")}`,
  ])
  warn.mockRestore()
})

test("a model on a removed provider is inactive", () => {
  writeModel("explore", "opencode", "openrouter/deepseek-v4", cwd)
  expect(loadDefinitions(cwd, added).find((entry) => entry.name === "explore")?.active).toBe(true)
  expect(loadDefinitions(cwd, () => false).find((entry) => entry.name === "explore")?.active).toBe(false)
  expect(readFileSync(join(globalFolder(), "explore.md"), "utf8")).toContain("permissions: read-only")
})
